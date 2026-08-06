import { Router } from 'express';
import { requireAuth } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';

const router = Router();

// GET /approval-queue - List all posts waiting for approval
router.get('/', requireAuth, requirePermission('content.approve'), async (req, res, next) => {
  try {
    const posts = await prisma.generatedPost.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: {
        campaign: true,
        campaignPage: { include: { facebookPage: true } },
        postMedias: { include: { mediaFile: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: posts });
  } catch (err) {
    next(err);
  }
});

export default router;
