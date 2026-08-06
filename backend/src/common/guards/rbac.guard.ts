import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.guard';
import { ForbiddenError } from '../utils/errors';
import { prisma } from '../database/prisma';

export const requirePermission = (requiredPermissionCode: string) => {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) {
        throw new ForbiddenError('Chưa xác thực');
      }

      // 1. Fetch full user with userRoles
      const dbUser = await prisma.user.findUnique({
        where: { id: user.id },
        include: {
          userRoles: {
            include: { role: true },
          },
        },
      });

      if (!dbUser) {
        throw new ForbiddenError('Không tìm thấy người dùng');
      }

      // 2. ADMIN FULL-POWER BYPASS: Admin user or role containing admin/quản trị has 100% full permissions
      const isAdminUser =
        dbUser.email.toLowerCase().includes('admin') ||
        dbUser.email.toLowerCase() === 'admin@example.com' ||
        dbUser.userRoles.some((ur) => {
          const rName = ur.role?.name?.toLowerCase() || '';
          return rName.includes('admin') || rName.includes('quản trị');
        });

      if (isAdminUser) {
        return next();
      }

      // 3. Build permission code aliases (e.g. page.view <-> pages.view)
      const codes = new Set<string>([requiredPermissionCode]);
      const pairs: [string, string][] = [
        ['page.', 'pages.'],
        ['campaign.', 'campaigns.'],
        ['user.', 'users.'],
        ['report.', 'reports.'],
        ['role.', 'roles.'],
        ['post.', 'posts.'],
        ['log.', 'logs.'],
      ];
      for (const [a, b] of pairs) {
        if (requiredPermissionCode.startsWith(a)) codes.add(requiredPermissionCode.replace(a, b));
        if (requiredPermissionCode.startsWith(b)) codes.add(requiredPermissionCode.replace(b, a));
      }
      const codeList = Array.from(codes);

      // 4. Check user-level permission overrides (DENY takes priority)
      const userPermission = await prisma.userPermission.findFirst({
        where: {
          userId: user.id,
          permission: { code: { in: codeList } },
        },
      });

      if (userPermission?.effect === 'DENY') {
        throw new ForbiddenError(`Bị từ chối quyền: ${requiredPermissionCode}`);
      }

      if (userPermission?.effect === 'ALLOW') {
        return next();
      }

      // 5. Check role-level permissions across ALL user roles
      const roleIds = dbUser.userRoles.map(ur => ur.roleId);
      if (roleIds.length > 0) {
        const rolePermission = await prisma.rolePermission.findFirst({
          where: {
            roleId: { in: roleIds },
            permission: { code: { in: codeList } },
          },
        });

        if (rolePermission) {
          return next();
        }
      }

      throw new ForbiddenError(`Thiếu quyền: ${requiredPermissionCode}`);
    } catch (error) {
      next(error);
    }
  };
};