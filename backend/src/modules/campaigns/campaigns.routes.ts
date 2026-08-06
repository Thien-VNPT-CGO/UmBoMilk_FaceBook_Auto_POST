import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { z } from 'zod';
import { NextFunction, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { contentGenerationQueue, postSchedulingQueue } from '../../common/queue/queues';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  originalContent: z.string().min(1),
  contentMode: z.enum(['SHARED', 'INDIVIDUAL']).default('SHARED'),
  mediaMode: z.enum(['IMAGE', 'VIDEO', 'MIXED']).default('IMAGE'),
  defaultPostCount: z.number().int().min(1).max(500).default(10),
  defaultIntervalMinutes: z.number().int().min(1).max(720).default(15),
  startDate: z.string().datetime(),
  allowedStartTime: z.string().default('08:00'),
  allowedEndTime: z.string().default('22:00'),
  timezone: z.string().default('Asia/Ho_Chi_Minh'),
  mandatoryKeywords: z.array(z.string()).default([]),
  bannedKeywords: z.array(z.string()).default([]),
  tone: z.string().optional(),
  allowEmoji: z.boolean().default(true),
  allowHashtag: z.boolean().default(true),
  ctaRequired: z.string().optional(),
  productName: z.string().optional(),
  brandName: z.string().optional(),
  productPrice: z.string().optional(),
  discountPrice: z.string().optional(),
  sku: z.string().optional(),
  allowMediaReuse: z.boolean().default(false),
  facebookPageIds: z.array(z.string().uuid()).min(1),
});

router.get('/', requirePermission('campaigns.view'), async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      include: { campaignPages: { include: { facebookPage: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: campaigns });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/',
  requirePermission('campaigns.create'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createSchema.parse(req.body);
      const created = await prisma.campaign.create({
        data: {
          userId: req.user!.id,
          name: data.name,
          description: data.description,
          originalContent: data.originalContent,
          contentMode: data.contentMode,
          mediaMode: data.mediaMode,
          defaultPostCount: data.defaultPostCount,
          defaultIntervalMinutes: data.defaultIntervalMinutes,
          startDate: new Date(data.startDate),
          allowedStartTime: data.allowedStartTime,
          allowedEndTime: data.allowedEndTime,
          timezone: data.timezone,
          mandatoryKeywords: data.mandatoryKeywords,
          bannedKeywords: data.bannedKeywords,
          tone: data.tone,
          allowEmoji: data.allowEmoji,
          allowHashtag: data.allowHashtag,
          ctaRequired: data.ctaRequired,
          productName: data.productName,
          brandName: data.brandName,
          productPrice: data.productPrice,
          discountPrice: data.discountPrice,
          sku: data.sku,
          allowMediaReuse: data.allowMediaReuse,
          status: 'PENDING_APPROVAL',
          campaignPages: {
            create: data.facebookPageIds.map((facebookPageId) => ({
              facebookPageId,
              postCount: data.defaultPostCount,
              intervalMinutes: data.defaultIntervalMinutes,
              startAt: new Date(data.startDate),
            })),
          },
        },
        include: { campaignPages: true },
      });

      // Synchronously generate initial posts for immediate approval queue visibility
      for (const cp of created.campaignPages) {
        for (let i = 0; i < cp.postCount; i++) {
          const scheduledAt = new Date(cp.startAt.getTime() + i * cp.intervalMinutes * 60000);
          let postContent = data.originalContent;
          if (cp.postCount > 1) {
            postContent = `[Bài ${i + 1}/${cp.postCount}] ${data.originalContent}`;
          }
          await prisma.generatedPost.create({
            data: {
              campaignId: created.id,
              campaignPageId: cp.id,
              content: postContent,
              mediaType: data.mediaMode === 'VIDEO' ? 'VIDEO' : 'IMAGE',
              scheduledAt,
              status: 'PENDING_APPROVAL',
              sequenceNumber: i + 1,
              idempotencyKey: buildIdempotencyKey(created.id, cp.facebookPageId, i + 1),
            },
          });
        }
      }

      try {
        await contentGenerationQueue.add(
          'generate',
          { campaignId: created.id },
          { jobId: `gen-${created.id}-${Date.now()}` }
        );
      } catch (err) {
        // Continue even if Redis queue fails
      }

      res.status(201).json({ success: true, data: { id: created.id } });
    } catch (e) {
      if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
      next(e);
    }
  }
);

router.get('/:id', requirePermission('campaigns.view'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: {
        campaignPages: { include: { facebookPage: true, generatedPosts: true } },
        mediaFiles: true,
      },
    });
    if (!campaign) throw new NotFoundError('Không tìm thấy chiến dịch');
    res.json({ success: true, data: campaign });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/schedule', requirePermission('campaigns.publish'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: { generatedPosts: true, campaignPages: true },
    });
    if (!campaign) throw new NotFoundError('Không tìm thấy chiến dịch');
    if (campaign.status !== 'PENDING_APPROVAL' && campaign.status !== 'APPROVED') {
      throw new BadRequestError('Chiến dịch cần được duyệt trước khi lên lịch');
    }
    const posts = campaign.generatedPosts.filter((p) => p.status === 'APPROVED' || p.status === 'SCHEDULED');
    for (const post of posts) {
      await postSchedulingQueue.add(
        'schedule',
        { postId: post.id },
        { jobId: post.idempotencyKey, delay: Math.max(0, post.scheduledAt.getTime() - Date.now()) }
      );
    }
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'SCHEDULED' },
    });
    res.json({ success: true, message: `Đã lên lịch ${posts.length} bài viết` });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/posts/:postId/approve',
  requirePermission('campaigns.approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const post = await prisma.generatedPost.findUnique({ where: { id: req.params.postId } });
      if (!post) throw new NotFoundError('Không tìm thấy bài viết');
      await prisma.$transaction([
        prisma.generatedPost.update({ where: { id: post.id }, data: { status: 'APPROVED', approvedAt: new Date() } }),
        prisma.approvalHistory.create({
          data: { generatedPostId: post.id, action: 'APPROVED', performedByUserId: (req as any).user.id },
        }),
      ]);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/posts/:postId/reject',
  requirePermission('campaigns.approve'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      const post = await prisma.generatedPost.findUnique({ where: { id: req.params.postId } });
      if (!post) throw new NotFoundError('Không tìm thấy bài viết');
      await prisma.$transaction([
        prisma.generatedPost.update({ where: { id: post.id }, data: { status: 'REJECTED' } }),
        prisma.approvalHistory.create({
          data: {
            generatedPostId: post.id,
            action: 'REJECTED',
            note,
            performedByUserId: (req as any).user.id,
          },
        }),
      ]);
      res.json({ success: true });
    } catch (e) {
      next(e);
    }
  }
);

router.put('/:id', requirePermission('campaigns.update'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) throw new NotFoundError('Không tìm thấy chiến dịch');
    
    const updateSchema = createSchema.partial();
    const data = updateSchema.parse(req.body);

    const updated = await prisma.campaign.update({
      where: { id: campaign.id },
      data: {
        name: data.name,
        description: data.description,
        originalContent: data.originalContent,
        contentMode: data.contentMode,
        mediaMode: data.mediaMode,
        defaultPostCount: data.defaultPostCount,
        defaultIntervalMinutes: data.defaultIntervalMinutes,
        productName: data.productName,
        brandName: data.brandName,
        productPrice: data.productPrice,
        discountPrice: data.discountPrice,
        sku: data.sku,
        tone: data.tone,
        ctaRequired: data.ctaRequired,
        allowEmoji: data.allowEmoji,
        allowHashtag: data.allowHashtag,
        allowMediaReuse: data.allowMediaReuse,
      },
    });
    res.json({ success: true, data: updated });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
    next(e);
  }
});

router.delete('/:id', requirePermission('campaigns.delete'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) throw new NotFoundError('Không tìm thấy chiến dịch');
    await prisma.$transaction([
      prisma.jobLog.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.mediaFile.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.campaignPage.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.generatedPost.deleteMany({ where: { campaignId: campaign.id } }),
      prisma.campaign.delete({ where: { id: campaign.id } }),
    ]);
    res.json({ success: true, message: 'Đã xóa chiến dịch thành công' });
  } catch (e) {
    next(e);
  }
});

// Idempotency helper to ensure unique keys for post inserts
export function buildIdempotencyKey(campaignId: string, facebookPageId: string, sequence: number) {
  return `post:${campaignId}:${facebookPageId}:${sequence}:${uuid()}`;
}

export default router;