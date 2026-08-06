import { Router } from 'express';
import { requireAuth, AuthenticatedRequest } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { AiService } from '../ai/ai.service';
import { facebookPublishingQueue } from '../../common/queue/queues';

const router = Router();

// 1. Get list of posts for a campaign
router.get('/campaigns/:campaignId/posts', requireAuth, requirePermission('post.view'), async (req, res, next) => {
  try {
    const posts = await prisma.generatedPost.findMany({
      where: { campaignId: req.params.campaignId },
      include: {
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { sequenceNumber: 'asc' },
    });
    res.json({ data: posts });
  } catch (err) {
    next(err);
  }
});

// 2. Get single post details
router.get('/:id', requireAuth, requirePermission('post.view'), async (req, res, next) => {
  try {
    const post = await prisma.generatedPost.findUnique({
      where: { id: req.params.id },
      include: {
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        contentRevisions: { include: { editedByUser: true }, orderBy: { createdAt: 'desc' } },
        approvalHistories: { include: { performedByUser: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');
    res.json({ data: post });
  } catch (err) {
    next(err);
  }
});

// 3. Edit post content (saves ContentRevision)
router.put('/:id', requireAuth, requirePermission('content.edit'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { content, editReason } = req.body;
    if (!content) throw new BadRequestError('Nội dung không được để trống');

    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: { content },
    });

    await prisma.contentRevision.create({
      data: {
        generatedPostId: post.id,
        oldContent: post.content,
        newContent: content,
        editedByUserId: authReq.user!.id,
        editReason: editReason || 'Chỉnh sửa bởi người dùng',
      },
    });

    res.json({ message: 'Đã cập nhật nội dung bài viết', data: updated });
  } catch (err) {
    next(err);
  }
});

// 4. Regenerate post content using AI
router.post('/:id/regenerate', requireAuth, requirePermission('content.regenerate'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const post = await prisma.generatedPost.findUnique({
      where: { id: req.params.id },
      include: { campaign: true },
    });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const newContents = await AiService.generatePosts({
      originalContent: post.campaign.originalContent,
      productName: post.campaign.productName,
      brandName: post.campaign.brandName,
      productPrice: post.campaign.productPrice,
      discountPrice: post.campaign.discountPrice,
      sku: post.campaign.sku,
      mandatoryKeywords: post.campaign.mandatoryKeywords,
      bannedKeywords: post.campaign.bannedKeywords,
      tone: post.campaign.tone,
      lengthConfig: post.campaign.lengthConfig,
      allowEmoji: post.campaign.allowEmoji,
      allowHashtag: post.campaign.allowHashtag,
      ctaRequired: post.campaign.ctaRequired,
      postCount: 1,
    });

    const newContent = newContents[0];

    await prisma.contentRevision.create({
      data: {
        generatedPostId: post.id,
        oldContent: post.content,
        newContent,
        editedByUserId: authReq.user!.id,
        editReason: 'Tạo lại bằng AI',
      },
    });

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: { content: newContent },
    });

    res.json({ message: 'Đã tạo lại nội dung thành công', data: updated });
  } catch (err) {
    next(err);
  }
});

// 5. Submit post for approval
router.post('/:id/submit-for-approval', requireAuth, requirePermission('content.edit'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: { status: 'PENDING_APPROVAL' },
    });

    await prisma.approvalHistory.create({
      data: {
        generatedPostId: post.id,
        action: 'SUBMITTED',
        note: 'Gửi duyệt bài viết',
        performedByUserId: authReq.user!.id,
      },
    });

    res.json({ message: 'Đã gửi duyệt bài viết', data: updated });
  } catch (err) {
    next(err);
  }
});

// 6. Approve post
router.post('/:id/approve', requireAuth, requirePermission('content.approve'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });

    await prisma.approvalHistory.create({
      data: {
        generatedPostId: post.id,
        action: 'APPROVED',
        note: req.body.note || 'Đã duyệt nội dung',
        performedByUserId: authReq.user!.id,
      },
    });

    res.json({ message: 'Đã duyệt bài viết', data: updated });
  } catch (err) {
    next(err);
  }
});

// 7. Reject post
router.post('/:id/reject', requireAuth, requirePermission('content.reject'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { note } = req.body;
    if (!note) throw new BadRequestError('Vui lòng nhập lý do từ chối');

    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: { status: 'REJECTED' },
    });

    await prisma.approvalHistory.create({
      data: {
        generatedPostId: post.id,
        action: 'REJECTED',
        note,
        performedByUserId: authReq.user!.id,
      },
    });

    res.json({ message: 'Đã từ chối bài viết', data: updated });
  } catch (err) {
    next(err);
  }
});

// 8. Publish post immediately (Publish Now)
router.post('/:id/publish-now', requireAuth, requirePermission('post.publish'), async (req, res, next) => {
  try {
    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const { publishPost } = await import('../../workers/post-publishing.worker');
    await publishPost(post.id);

    const updated = await prisma.generatedPost.findUnique({ where: { id: post.id } });
    res.json({
      success: true,
      message: `Đã đăng bài thành công lên Facebook Page! Post ID: ${updated?.facebookPostId || 'OK'}`,
      data: updated,
    });
  } catch (err: any) {
    const msg = err.response?.data?.error?.message || err.message || 'Lỗi đăng bài Facebook';
    res.status(400).json({ success: false, message: `Lỗi đăng bài Facebook: ${msg}` });
  }
});

// 9. Retry failed post
router.post('/:id/retry', requireAuth, requirePermission('post.retry'), async (req, res, next) => {
  try {
    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    await prisma.generatedPost.update({
      where: { id: post.id },
      data: { status: 'RETRYING', retryCount: post.retryCount + 1 },
    });

    await facebookPublishingQueue.add(
      'retry-publish',
      { postId: post.id },
      { jobId: `retry-${post.id}-${Date.now()}` }
    );

    res.json({ message: 'Đang thử lại đăng bài' });
  } catch (err) {
    next(err);
  }
});

// 10. Change media files attached to a post
router.post('/:id/change-media', requireAuth, requirePermission('media.assign'), async (req, res, next) => {
  try {
    const { mediaFileIds } = req.body;
    if (!Array.isArray(mediaFileIds)) throw new BadRequestError('mediaFileIds phải là mảng');

    const post = await prisma.generatedPost.findUnique({ where: { id: req.params.id } });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    if (post.mediaType === 'IMAGE' && mediaFileIds.length !== 6) {
      throw new BadRequestError('Bài hình ảnh bắt buộc chọn đúng 6 hình');
    }
    if (post.mediaType === 'VIDEO' && mediaFileIds.length !== 1) {
      throw new BadRequestError('Bài video bắt buộc chọn đúng 1 video');
    }

    await prisma.postMedia.deleteMany({ where: { generatedPostId: post.id } });

    for (let i = 0; i < mediaFileIds.length; i++) {
      await prisma.postMedia.create({
        data: {
          generatedPostId: post.id,
          mediaFileId: mediaFileIds[i],
          sortOrder: i,
        },
      });
    }

    res.json({ message: 'Đã thay đổi media cho bài viết' });
  } catch (err) {
    next(err);
  }
});

export default router;
