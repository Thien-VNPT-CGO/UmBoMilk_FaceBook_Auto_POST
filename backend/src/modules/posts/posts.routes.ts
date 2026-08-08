import { Router } from 'express';
import axios from 'axios';
import { requireAuth, AuthenticatedRequest } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { AiService } from '../ai/ai.service';
import { facebookPublishingQueue } from '../../common/queue/queues';

const router = Router();

// 0. Get all posts across campaigns for reports & analytics
router.get('/', requireAuth, requirePermission('post.view'), async (_req, res, next) => {
  try {
    const posts = await prisma.generatedPost.findMany({
      include: {
        campaign: true,
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    const expiredPending = posts.filter(p => p.status === 'PENDING_APPROVAL' && p.scheduledAt && p.scheduledAt.getTime() < now.getTime());
    if (expiredPending.length > 0) {
      for (let i = 0; i < expiredPending.length; i++) {
        const p = expiredPending[i];
        const interval = p.campaignPage?.intervalMinutes || 15;
        const newSched = new Date(now.getTime() + (i + 1) * interval * 60 * 1000);
        await prisma.generatedPost.update({
          where: { id: p.id },
          data: { scheduledAt: newSched },
        }).catch(() => {});
        p.scheduledAt = newSched;
      }
    }

    res.json({ success: true, data: posts });
  } catch (err) {
    next(err);
  }
});

// 0.1 Real-time Reports Summary Endpoint
router.get('/reports/summary', requireAuth, async (_req, res, next) => {
  try {
    const posts = await prisma.generatedPost.findMany({
      include: {
        campaignPage: { include: { facebookPage: true } },
      },
    });

    const pages = await prisma.facebookPage.findMany();

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        action: { in: ['DELETE_POST', 'BULK_DELETE_POST', 'CANCEL_POST', 'BULK_CANCEL_POST'] }
      },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const publishedCount = posts.filter(p => p.status === 'PUBLISHED').length;
    const failedCount = posts.filter(p => p.status === 'FAILED').length;
    const cancelledCount = posts.filter(p => p.status === 'REJECTED' || p.status === 'CANCELLED').length;
    const deletedCount = auditLogs.filter(l => l.action.includes('DELETE')).length;

    const totalProcessed = publishedCount + failedCount;
    const successRate = totalProcessed > 0 ? Math.round((publishedCount / totalProcessed) * 100) : 100;

    const pageStats = pages.map(page => {
      const pagePosts = posts.filter(p => p.campaignPage?.facebookPageId === page.facebookPageId || p.campaignPage?.facebookPage?.id === page.id);
      const pub = pagePosts.filter(p => p.status === 'PUBLISHED').length;
      const fail = pagePosts.filter(p => p.status === 'FAILED').length;
      const canc = pagePosts.filter(p => p.status === 'REJECTED' || p.status === 'CANCELLED').length;

      const pageDeletedLogs = auditLogs.filter(l => {
        const val = (l.oldValue || l.newValue) as any;
        return l.action.includes('DELETE') && (val?.pageName === page.pageName || val?.facebookPageId === page.facebookPageId);
      });

      const tot = pagePosts.length;
      const proc = pub + fail;
      const rate = proc > 0 ? Math.round((pub / proc) * 100) : (tot > 0 ? 100 : 0);

      return {
        id: page.id,
        pageName: page.pageName,
        facebookPageId: page.facebookPageId,
        totalPosts: tot,
        publishedCount: pub,
        failedCount: fail,
        cancelledCount: canc,
        deletedCount: pageDeletedLogs.length,
        successRate: rate,
      };
    });

    // Detailed cancellation & deletion timeline logs
    const detailedLogs = auditLogs.map(log => {
      const val = (log.oldValue || log.newValue) as any;
      const isDelete = log.action.includes('DELETE');
      return {
        id: log.id,
        actionType: isDelete ? 'DELETE' : 'CANCEL',
        actionLabel: isDelete ? '🗑️ Xóa bài viết' : '🚫 Hủy bài viết',
        contentPreview: val?.content || 'Nội dung bài viết',
        pageName: val?.pageName || 'Facebook Page',
        performedBy: log.user?.name || log.user?.username || log.user?.email || 'Quản trị viên',
        timestamp: new Date(log.createdAt).toLocaleString('vi-VN'),
        note: isDelete
          ? (val?.deletedOnFb ? 'Đã xóa bài viết khỏi hệ thống và xóa trên Facebook Page' : 'Đã xóa bài viết khỏi hệ thống')
          : 'Đã hủy bài viết - Không cho phép đăng',
      };
    });

    res.json({
      success: true,
      data: {
        publishedCount,
        failedCount,
        cancelledCount,
        deletedCount,
        successRate,
        pageStats,
        detailedLogs,
      }
    });
  } catch (err) {
    next(err);
  }
});

// 1. Get list of posts for a campaign
router.get('/campaigns/:campaignId/posts', requireAuth, requirePermission('post.view'), async (req, res, next) => {
  try {
    const campaignId = req.params.campaignId;
    let posts = await prisma.generatedPost.findMany({
      where: { campaignId },
      include: {
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { sequenceNumber: 'asc' },
    });

    const isMissingMedia = posts.some(p => !p.postMedias || p.postMedias.length === 0);
    if (isMissingMedia) {
      const { MediaService } = await import('../media/media.service');
      await MediaService.assignMediaToCampaign(campaignId).catch(() => {});
      posts = await prisma.generatedPost.findMany({
        where: { campaignId },
        include: {
          campaignPage: { include: { facebookPage: true } },
          postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { sequenceNumber: 'asc' },
      });
    }

    res.json({ data: posts });
  } catch (err) {
    next(err);
  }
});

// 2. Get single post details
router.get('/:id', requireAuth, requirePermission('post.view'), async (req, res, next) => {
  try {
    let post = await prisma.generatedPost.findUnique({
      where: { id: req.params.id },
      include: {
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        contentRevisions: { include: { editedByUser: true }, orderBy: { createdAt: 'desc' } },
        approvalHistories: { include: { performedByUser: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    if (!post.postMedias || post.postMedias.length === 0) {
      const { MediaService } = await import('../media/media.service');
      await MediaService.assignMediaToCampaign(post.campaignId).catch(() => {});
      post = await prisma.generatedPost.findUnique({
        where: { id: req.params.id },
        include: {
          campaignPage: { include: { facebookPage: true } },
          postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
          contentRevisions: { include: { editedByUser: true }, orderBy: { createdAt: 'desc' } },
          approvalHistories: { include: { performedByUser: true }, orderBy: { createdAt: 'desc' } },
        },
      });
    }

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

    try {
      const { MediaService } = await import('../media/media.service');
      await MediaService.assignMediaToCampaign(post.campaignId);
    } catch (e) {}

    const refetched = await prisma.generatedPost.findUnique({
      where: { id: post.id },
      include: {
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        campaignPage: { include: { facebookPage: true } }
      }
    });

    res.json({ message: 'Đã tạo lại nội dung bài viết thành công!', data: refetched || updated });
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

// 6. Approve post (Guarantees minimum 15-minute gap between posts per Facebook Page)
router.post('/:id/approve', requireAuth, requirePermission('content.approve'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const post = await prisma.generatedPost.findUnique({
      where: { id: req.params.id },
      include: { campaignPage: { include: { facebookPage: true } } },
    });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const now = new Date();
    const facebookPageId = post.campaignPage?.facebookPageId;
    const pageCustomInterval = post.campaignPage?.facebookPage?.defaultIntervalMinutes;
    const intervalMinutes = pageCustomInterval || post.campaignPage?.intervalMinutes || 15;
    const intervalMs = intervalMinutes * 60 * 1000;

    // Query latest approved/scheduled/published post for the SAME Facebook Page (across all campaigns)
    const lastApprovedPost = await prisma.generatedPost.findFirst({
      where: {
        campaignPage: { facebookPageId },
        status: { in: ['APPROVED', 'SCHEDULED', 'PUBLISHED'] },
        id: { not: post.id },
      },
      orderBy: { scheduledAt: 'desc' },
    });

    let targetScheduledAt = now;
    if (lastApprovedPost && lastApprovedPost.scheduledAt) {
      const lastTime = lastApprovedPost.scheduledAt.getTime();
      if (lastTime > now.getTime()) {
        targetScheduledAt = new Date(lastTime + intervalMs);
      } else {
        const diff = now.getTime() - lastTime;
        if (diff < intervalMs) {
          targetScheduledAt = new Date(lastTime + intervalMs);
        }
      }
    } else if (post.scheduledAt && post.scheduledAt.getTime() > now.getTime()) {
      targetScheduledAt = post.scheduledAt;
    }

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: {
        status: 'APPROVED',
        approvedAt: now,
        scheduledAt: targetScheduledAt,
      },
    });

    // Enqueue delayed publication job
    const delay = Math.max(0, targetScheduledAt.getTime() - now.getTime());
    const { postSchedulingQueue } = await import('../../common/queue/queues');
    await postSchedulingQueue.add(
      'schedule-post',
      { postId: post.id },
      {
        delay,
        jobId: `sched-${post.id}-${Date.now()}`,
        removeOnComplete: true,
      }
    ).catch(() => {});

    await prisma.approvalHistory.create({
      data: {
        generatedPostId: post.id,
        action: 'APPROVED',
        note: req.body.note || `Đã duyệt bài đăng (Lên lịch: ${targetScheduledAt.toLocaleTimeString('vi-VN')} - Tự động giãn cách 15 phút)`,
        performedByUserId: authReq.user!.id,
      },
    });

    res.json({
      success: true,
      message: `🎉 Đã duyệt bài viết thành công! Thời gian lên lịch đăng: ${targetScheduledAt.toLocaleTimeString('vi-VN')} (Tự động giãn cách 15 phút).`,
      data: updated
    });
  } catch (err) {
    next(err);
  }
});

// 6.1 Bulk Approve Posts (Auto-spacing 15 minutes apart per Facebook Page)
router.post('/bulk-approve', requireAuth, requirePermission('content.approve'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { postIds } = req.body;
    if (!Array.isArray(postIds) || !postIds.length) {
      throw new BadRequestError('Danh sách postIds không hợp lệ');
    }

    // Sort posts by scheduledAt ascending (earliest scheduled time / smallest seconds first!)
    const posts = await prisma.generatedPost.findMany({
      where: { id: { in: postIds } },
      include: { campaignPage: { include: { facebookPage: true } } },
      orderBy: [
        { scheduledAt: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    const now = new Date();
    const approvedPosts = [];

    for (const post of posts) {
      const facebookPageId = post.campaignPage?.facebookPageId;
      const pageCustomInterval = post.campaignPage?.facebookPage?.defaultIntervalMinutes;
      const intervalMinutes = pageCustomInterval || post.campaignPage?.intervalMinutes || 15;
      const intervalMs = intervalMinutes * 60 * 1000;

      // Query latest approved/scheduled/published post for this Facebook Page
      const lastApprovedPost = await prisma.generatedPost.findFirst({
        where: {
          campaignPage: { facebookPageId },
          status: { in: ['APPROVED', 'SCHEDULED', 'PUBLISHED'] },
          id: { not: post.id },
        },
        orderBy: { scheduledAt: 'desc' },
      });

      let targetScheduledAt = now;
      if (lastApprovedPost && lastApprovedPost.scheduledAt) {
        const lastTime = lastApprovedPost.scheduledAt.getTime();
        if (lastTime > now.getTime()) {
          targetScheduledAt = new Date(lastTime + intervalMs);
        } else {
          const diff = now.getTime() - lastTime;
          if (diff < intervalMs) {
            targetScheduledAt = new Date(lastTime + intervalMs);
          }
        }
      }

      const updated = await prisma.generatedPost.update({
        where: { id: post.id },
        data: {
          status: 'APPROVED',
          approvedAt: now,
          scheduledAt: targetScheduledAt,
        },
      });
      approvedPosts.push(updated);

      const delay = Math.max(0, targetScheduledAt.getTime() - now.getTime());
      const { postSchedulingQueue } = await import('../../common/queue/queues');
      await postSchedulingQueue.add(
        'schedule-post',
        { postId: post.id },
        {
          delay,
          jobId: `sched-${post.id}-${Date.now()}`,
          removeOnComplete: true,
        }
      ).catch(() => {});
    }

    res.json({
      success: true,
      message: `🎉 Đã duyệt hàng loạt ${approvedPosts.length} bài viết! Các bài tự động giãn cách 15 phút.`,
      data: approvedPosts,
    });
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

// 11. Delete post (Also deletes live post on Facebook Page if already published)
router.delete('/:id', requireAuth, requirePermission('content.edit'), async (req, res, next) => {
  try {
    const post = await prisma.generatedPost.findUnique({
      where: { id: req.params.id },
      include: {
        campaignPage: { include: { facebookPage: true } },
      },
    });

    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    let deletedOnFb = false;

    // If post has been published to Facebook, call Graph API DELETE /v19.0/{facebookPostId}
    if (post.facebookPostId && post.campaignPage?.facebookPage) {
      try {
        const page = post.campaignPage.facebookPage;
        const { decryptString } = await import('../../common/encryption/crypto');
        const token = decryptString(page.encryptedPageAccessToken);
        if (token) {
          await axios.delete(`https://graph.facebook.com/v19.0/${post.facebookPostId}`, {
            params: { access_token: token }
          });
          deletedOnFb = true;
        }
      } catch (fbErr: any) {
        console.warn(`[FB Graph API Delete Warning] Lỗi xóa trên FB Page:`, fbErr.response?.data || fbErr.message);
      }
    }

    // Record AuditLog before deletion
    const authReq = req as AuthenticatedRequest;
    await prisma.auditLog.create({
      data: {
        userId: authReq.user?.id,
        action: 'DELETE_POST',
        entityType: 'GENERATED_POST',
        entityId: post.id,
        oldValue: {
          content: post.content ? post.content.substring(0, 120) : '',
          pageName: post.campaignPage?.facebookPage?.pageName,
          facebookPostId: post.facebookPostId,
          deletedOnFb,
        },
      },
    }).catch(() => {});

    // Clean up DB relations
    await prisma.postMedia.deleteMany({ where: { generatedPostId: post.id } });
    await prisma.contentRevision.deleteMany({ where: { generatedPostId: post.id } });
    await prisma.approvalHistory.deleteMany({ where: { generatedPostId: post.id } });
    await prisma.generatedPost.delete({ where: { id: post.id } });

    res.json({
      success: true,
      message: `Đã xóa bài viết khỏi hệ thống${deletedOnFb ? ' và đã xóa bài viết trực tiếp trên Facebook Page!' : '.'}`,
    });
  } catch (err) {
    next(err);
  }
});

// 12. Cancel post (Prevents post from being published to Facebook Page)
router.post('/:id/cancel', requireAuth, requirePermission('content.edit'), async (req, res, next) => {
  try {
    const post = await prisma.generatedPost.findUnique({
      where: { id: req.params.id },
      include: { campaignPage: { include: { facebookPage: true } } },
    });
    if (!post) throw new NotFoundError('Không tìm thấy bài viết');

    const updated = await prisma.generatedPost.update({
      where: { id: post.id },
      data: { status: 'REJECTED' },
    });

    const authReq = req as AuthenticatedRequest;
    await prisma.approvalHistory.create({
      data: {
        generatedPostId: post.id,
        performedByUserId: authReq.user!.id,
        action: 'REJECTED',
        note: 'Đã hủy bài viết - Không cho phép đăng lên Facebook Page',
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: authReq.user?.id,
        action: 'CANCEL_POST',
        entityType: 'GENERATED_POST',
        entityId: post.id,
        newValue: {
          content: post.content ? post.content.substring(0, 120) : '',
          pageName: post.campaignPage?.facebookPage?.pageName,
          status: 'REJECTED',
        },
      },
    }).catch(() => {});

    res.json({
      success: true,
      message: '🚫 Đã hủy bài viết thành công. Bài viết sẽ không được đăng lên Facebook Page.',
      data: updated,
    });
  } catch (err) {
    next(err);
  }
});

// 13. Bulk cancel posts
router.post('/bulk-cancel', requireAuth, requirePermission('content.edit'), async (req, res, next) => {
  try {
    const { postIds } = req.body;
    if (!Array.isArray(postIds) || !postIds.length) {
      throw new BadRequestError('Danh sách postIds không hợp lệ');
    }

    const posts = await prisma.generatedPost.findMany({
      where: { id: { in: postIds } },
      include: { campaignPage: { include: { facebookPage: true } } },
    });

    const updated = await prisma.generatedPost.updateMany({
      where: { id: { in: postIds } },
      data: { status: 'REJECTED' },
    });

    const authReq = req as AuthenticatedRequest;
    await prisma.approvalHistory.createMany({
      data: postIds.map(id => ({
        generatedPostId: id,
        performedByUserId: authReq.user!.id,
        action: 'REJECTED',
        note: 'Hủy hàng loạt bài viết bởi người dùng',
      })),
    });

    for (const p of posts) {
      await prisma.auditLog.create({
        data: {
          userId: authReq.user?.id,
          action: 'BULK_CANCEL_POST',
          entityType: 'GENERATED_POST',
          entityId: p.id,
          newValue: {
            content: p.content ? p.content.substring(0, 120) : '',
            pageName: p.campaignPage?.facebookPage?.pageName,
            status: 'REJECTED',
          },
        },
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `🚫 Đã hủy thành công ${updated.count} bài viết!`,
    });
  } catch (err) {
    next(err);
  }
});

// 14. Bulk delete posts (Deletes live posts on Facebook Page as well if published)
router.post('/bulk-delete', requireAuth, requirePermission('content.edit'), async (req, res, next) => {
  try {
    const { postIds } = req.body;
    if (!Array.isArray(postIds) || !postIds.length) {
      throw new BadRequestError('Danh sách postIds không hợp lệ');
    }

    const posts = await prisma.generatedPost.findMany({
      where: { id: { in: postIds } },
      include: { campaignPage: { include: { facebookPage: true } } },
    });

    const authReq = req as AuthenticatedRequest;
    let fbDeletedCount = 0;

    for (const p of posts) {
      let deletedOnFb = false;
      if (p.facebookPostId && p.campaignPage?.facebookPage) {
        try {
          const page = p.campaignPage.facebookPage;
          const { decryptString } = await import('../../common/encryption/crypto');
          const token = decryptString(page.encryptedPageAccessToken);
          if (token) {
            await axios.delete(`https://graph.facebook.com/v19.0/${p.facebookPostId}`, {
              params: { access_token: token }
            });
            fbDeletedCount++;
            deletedOnFb = true;
          }
        } catch (e: any) {
          console.warn(`[Bulk Delete FB Warning] Post ${p.facebookPostId}:`, e.message);
        }
      }

      await prisma.auditLog.create({
        data: {
          userId: authReq.user?.id,
          action: 'BULK_DELETE_POST',
          entityType: 'GENERATED_POST',
          entityId: p.id,
          oldValue: {
            content: p.content ? p.content.substring(0, 120) : '',
            pageName: p.campaignPage?.facebookPage?.pageName,
            facebookPostId: p.facebookPostId,
            deletedOnFb,
          },
        },
      }).catch(() => {});
    }

    await prisma.postMedia.deleteMany({ where: { generatedPostId: { in: postIds } } });
    await prisma.contentRevision.deleteMany({ where: { generatedPostId: { in: postIds } } });
    await prisma.approvalHistory.deleteMany({ where: { generatedPostId: { in: postIds } } });
    const deleted = await prisma.generatedPost.deleteMany({ where: { id: { in: postIds } } });

    res.json({
      success: true,
      message: `Đã xóa ${deleted.count} bài viết khỏi hệ thống${fbDeletedCount > 0 ? ` (và đã xóa ${fbDeletedCount} bài trên Facebook Page)` : ''}!`,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
