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

      // 1. Fetch ALL roles of this user
      const allUserRoles = await prisma.userRole.findMany({
        where: { userId: user.id },
        include: { role: true },
      });

      // 2. Admin role bypasses ALL permission checks
      for (const ur of allUserRoles) {
        if (ur.role.name.toLowerCase() === 'admin') {
          return next();
        }
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
      const roleIds = allUserRoles.map(ur => ur.roleId);
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