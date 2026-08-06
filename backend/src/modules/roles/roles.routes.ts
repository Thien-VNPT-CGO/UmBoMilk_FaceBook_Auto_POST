import { Router } from 'express';
import { authenticate } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { z } from 'zod';
import { AuthenticatedRequest } from '../../common/guards/auth.guard';
import { NextFunction, Response } from 'express';

const router = Router();
router.use(authenticate);

router.get('/permissions', requirePermission('roles.view'), async (_req, res, next) => {
  try {
    const items = await prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { name: 'asc' }] });
    res.json({ success: true, data: items });
  } catch (e) {
    next(e);
  }
});

router.get('/', requirePermission('roles.view'), async (_req, res, next) => {
  try {
    const roles = await prisma.role.findMany({
      include: {
        rolePermissions: { include: { permission: true } },
        _count: { select: { userRoles: true } },
      },
      orderBy: { name: 'asc' },
    });
    res.json({
      success: true,
      data: roles.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        isSystemRole: role.isSystemRole,
        userCount: role._count.userRoles,
        permissions: role.rolePermissions.map((rp) => ({
          id: rp.permission.id,
          code: rp.permission.code,
          name: rp.permission.name,
        })),
      })),
    });
  } catch (e) {
    next(e);
  }
});

const upsertSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  permissionIds: z.array(z.string().uuid()).default([]),
});

router.post(
  '/',
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = upsertSchema.parse(req.body);
      const created = await prisma.role.create({
        data: {
          name: data.name,
          description: data.description,
          rolePermissions: {
            create: data.permissionIds.map((permissionId) => ({ permissionId })),
          },
        },
      });
      res.status(201).json({ success: true, data: { id: created.id } });
    } catch (e) {
      if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
      next(e);
    }
  }
);

router.put(
  '/:id',
  requirePermission('roles.manage'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = upsertSchema.partial().parse(req.body);
      const role = await prisma.role.findUnique({ where: { id: req.params.id } });
      if (!role) throw new NotFoundError('Không tìm thấy vai trò');
      await prisma.$transaction(async (tx) => {
        await tx.role.update({
          where: { id: role.id },
          data: { name: data.name ?? role.name, description: data.description ?? role.description },
        });
        if (data.permissionIds) {
          await tx.rolePermission.deleteMany({ where: { roleId: role.id } });
          await tx.rolePermission.createMany({
            data: data.permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
            skipDuplicates: true,
          });
        }
      });
      res.json({ success: true });
    } catch (e) {
      if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
      next(e);
    }
  }
);

export default router;