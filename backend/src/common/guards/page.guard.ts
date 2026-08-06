import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.guard';
import { ForbiddenError, NotFoundError } from '../utils/errors';
import { prisma } from '../database/prisma';

export type PagePermissionKey =
  | 'canView'
  | 'canEditContent'
  | 'canApproveContent'
  | 'canManageSchedule'
  | 'canPublish';

export const requirePageAccess = (
  permissionKey: PagePermissionKey,
  paramName = 'id' // parameter name representing either campaignId, facebookPageId or postId
) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user) {
        throw new ForbiddenError('Chưa xác thực');
      }

      // 1. If admin, grant access automatically (Section 3)
      const role = await prisma.role.findFirst({
        where: { id: user.roleId },
      });
      if (role?.name === 'ADMIN') {
        return next();
      }

      const paramValue = req.params[paramName];
      if (!paramValue) {
        throw new ForbiddenError('Không tìm thấy thông tin định danh trang');
      }

      let facebookPageId: string | null = null;

      // Extract facebookPageId based on target parameter (Page, Campaign, Post, Media)
      if (req.baseUrl.includes('facebook-pages')) {
        const page = await prisma.facebookPage.findUnique({
          where: { id: paramValue },
        });
        if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');
        facebookPageId = page.id;
      } else if (req.baseUrl.includes('campaigns')) {
        // Find if this user has access to any page within the campaign
        const campaignPages = await prisma.campaignPage.findMany({
          where: { campaignId: paramValue },
          select: { facebookPageId: true },
        });
        const pageIds = campaignPages.map((cp) => cp.facebookPageId);

        // Check if user has permission on at least one page in the campaign
        const userAccess = await prisma.userFacebookPage.findFirst({
          where: {
            userId: user.id,
            facebookPageId: { in: pageIds },
            [permissionKey]: true,
          },
        });

        if (userAccess) {
          return next();
        }
        throw new ForbiddenError('Bạn không có quyền thao tác trên chiến dịch chứa các trang này');
      } else if (req.baseUrl.includes('posts')) {
        const post = await prisma.generatedPost.findUnique({
          where: { id: paramValue },
          include: { campaignPage: true },
        });
        if (!post) throw new NotFoundError('Không tìm thấy bài viết');
        facebookPageId = post.campaignPage.facebookPageId;
      }

      if (!facebookPageId) {
        throw new ForbiddenError('Không xác định được trang đích');
      }

      // Check specific page authorization
      const userPageAccess = await prisma.userFacebookPage.findFirst({
        where: {
          userId: user.id,
          facebookPageId: facebookPageId,
          [permissionKey]: true,
        },
      });

      if (!userPageAccess) {
        throw new ForbiddenError('Bạn không có quyền thực hiện hành động này trên Page đã chỉ định');
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};