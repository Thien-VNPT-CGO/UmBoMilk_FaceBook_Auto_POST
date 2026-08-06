import { Router } from 'express';
import { requireAuth } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';

const router = Router();

// GET /permissions - List all system permissions
router.get('/', requireAuth, requirePermission('role.view'), async (_req, res, next) => {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: [{ module: 'asc' }, { code: 'asc' }],
    });
    res.json({ data: permissions });
  } catch (err) {
    next(err);
  }
});

export default router;
