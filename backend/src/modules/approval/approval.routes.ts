import { Router } from 'express';
import { requireAuth } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';

const router = Router();

// GET /approval-queue - List all posts waiting for approval
router.get('/', requireAuth, requirePermission('content.approve'), async (req, res, next) => {
  try {
    let posts = await prisma.generatedPost.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: {
        campaign: true,
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Check if any post is missing media
    const unassignedCampaignIds = [...new Set(posts.filter(p => !p.postMedias || p.postMedias.length === 0).map(p => p.campaignId))];
    if (unassignedCampaignIds.length > 0) {
      const { MediaService } = await import('../media/media.service');
      for (const cid of unassignedCampaignIds) {
        await MediaService.assignMediaToCampaign(cid).catch(() => {});
      }
      posts = await prisma.generatedPost.findMany({
        where: { status: 'PENDING_APPROVAL' },
        include: {
          campaign: true,
          campaignPage: { include: { facebookPage: true } },
          postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        },
        orderBy: { createdAt: 'desc' },
      });
    }

    res.json({ data: posts });
  } catch (err) {
    next(err);
  }
});

export default router;
