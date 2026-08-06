import { Router } from 'express';
import { requireAuth } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';

const router = Router();

// GET /logs - Get system job logs
router.get('/', requireAuth, requirePermission('log.view'), async (req, res, next) => {
  try {
    const logs = await prisma.jobLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ data: logs });
  } catch (err) {
    next(err);
  }
});

// GET /logs/audit - Get audit logs
router.get('/audit', requireAuth, requirePermission('audit.view'), async (req, res, next) => {
  try {
    const auditLogs = await prisma.auditLog.findMany({
      include: { user: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ data: auditLogs });
  } catch (err) {
    next(err);
  }
});

export default router;
