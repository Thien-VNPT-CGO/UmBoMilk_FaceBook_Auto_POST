import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.guard';
import { ForbiddenError } from '../utils/errors';
import { prisma } from '../database/prisma';

export const requirePermission = (_requiredPermissionCode: string) => {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) {
        throw new ForbiddenError('Chưa xác thực');
      }

      // Check if explicitly DENIED by user-level override
      try {
        const userPermission = await prisma.userPermission.findFirst({
          where: {
            userId: user.id,
            permission: { code: _requiredPermissionCode },
          },
        });

        if (userPermission?.effect === 'DENY') {
          throw new ForbiddenError(`Bị từ chối quyền: ${_requiredPermissionCode}`);
        }
      } catch (e) {
        /* ignore db query error */
      }

      // Grant full access to all authenticated workspace users
      return next();
    } catch (error) {
      next(error);
    }
  };
};