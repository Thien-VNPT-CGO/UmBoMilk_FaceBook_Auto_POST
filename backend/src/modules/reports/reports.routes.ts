import { Router } from 'express';
import { authenticate } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { NextFunction, Response } from 'express';

const router = Router();
router.use(authenticate);

router.get(
  '/overview',
  requirePermission('reports.view'),
  async (_req, res: Response, next: NextFunction) => {
    try {
      const [totalCampaigns, totalPosts, totalPublished, totalFailed] = await Promise.all([
        prisma.campaign.count(),
        prisma.generatedPost.count(),
        prisma.generatedPost.count({ where: { status: 'PUBLISHED' } }),
        prisma.generatedPost.count({ where: { status: 'FAILED' } }),
      ]);
      res.json({
        success: true,
        data: { totalCampaigns, totalPosts, totalPublished, totalFailed },
      });
    } catch (e) {
      next(e);
    }
  }
);

router.get(
  '/posts',
  requirePermission('reports.view'),
  async (req, res: Response, next: NextFunction) => {
    try {
      const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : undefined;
      const posts = await prisma.generatedPost.findMany({
        where: campaignId ? { campaignId } : undefined,
        orderBy: { scheduledAt: 'desc' },
        take: 50,
        include: { campaign: { select: { name: true } }, campaignPage: { include: { facebookPage: true } } },
      });
      res.json({ success: true, data: posts });
    } catch (e) {
      next(e);
    }
  }
);

export default router;