import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.guard';
import { ForbiddenError } from '../utils/errors';

export type PagePermissionKey =
  | 'canView'
  | 'canEditContent'
  | 'canApproveContent'
  | 'canManageSchedule'
  | 'canPublish';

export const requirePageAccess = (
  _permissionKey: PagePermissionKey,
  _paramName = 'id'
) => {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) {
        throw new ForbiddenError('Chưa xác thực');
      }
      return next();
    } catch (error) {
      next(error);
    }
  };
};