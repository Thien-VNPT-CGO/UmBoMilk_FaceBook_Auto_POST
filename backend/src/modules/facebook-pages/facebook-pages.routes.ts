import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { requirePageAccess } from '../../common/guards/page.guard';
import { prisma } from '../../common/database/prisma';
import { encryptString } from '../../common/encryption/crypto';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { z } from 'zod';
import axios from 'axios';
import { NextFunction, Request, Response } from 'express';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  pageName: z.string().min(1),
  facebookPageId: z.string().min(5),
  pageAccessToken: z.string().min(10),
  defaultPostCount: z.number().int().min(1).max(500).default(10),
  defaultIntervalMinutes: z.number().int().min(1).max(720).default(15),
});

router.get('/', requirePermission('page.view'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const isAdmin = req.user?.roleId
      ? !!(await prisma.role.findFirst({ where: { id: req.user.roleId, name: { in: ['Admin', 'ADMIN'] } } }))
      : false;

    const pages = await prisma.facebookPage.findMany({
      where: isAdmin
        ? undefined
        : { userFacebookPages: { some: { userId: req.user!.id, canView: true } } },
      include: { owner: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: pages.map((p) => ({ ...p, pageAccessToken: undefined })) });
  } catch (e) {
    next(e);
  }
});

router.post(
  '/',
  requirePermission('page.create'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createSchema.parse(req.body);
      const exists = await prisma.facebookPage.findUnique({ where: { facebookPageId: data.facebookPageId } });
      if (exists) throw new BadRequestError('Facebook Page đã được đăng ký');

      const created = await prisma.facebookPage.create({
        data: {
          ownerId: req.user!.id,
          pageName: data.pageName,
          facebookPageId: data.facebookPageId,
          encryptedPageAccessToken: encryptString(data.pageAccessToken),
          defaultPostCount: data.defaultPostCount,
          defaultIntervalMinutes: data.defaultIntervalMinutes,
        },
      });
      await prisma.userFacebookPage.create({
        data: {
          userId: req.user!.id,
          facebookPageId: created.id,
          canView: true,
          canEditContent: true,
          canApproveContent: true,
          canManageSchedule: true,
          canPublish: true,
        },
      });
      res.status(201).json({ success: true, data: { id: created.id } });
    } catch (e) {
      if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
      next(e);
    }
  }
);

router.get(
  '/:id',
  requirePageAccess('canView'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = await prisma.facebookPage.findUnique({ where: { id: req.params.id } });
      if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');
      res.json({ success: true, data: { ...page, pageAccessToken: undefined } });
    } catch (e) {
      next(e);
    }
  }
);

router.delete(
  '/:id',
  requirePermission('page.delete'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = await prisma.facebookPage.findUnique({ where: { id: req.params.id } });
      if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');
      await prisma.$transaction([
        prisma.campaignPage.deleteMany({ where: { facebookPageId: req.params.id } }),
        prisma.userFacebookPage.deleteMany({ where: { facebookPageId: req.params.id } }),
        prisma.facebookPage.delete({ where: { id: req.params.id } }),
      ]);
      res.json({ success: true, message: 'Đã xóa Facebook Page' });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/:id/test',
  requirePageAccess('canView'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = await prisma.facebookPage.findUnique({ where: { id: req.params.id } });
      if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');
      const { decryptString } = await import('../../common/encryption/crypto');
      const accessToken = decryptString(page.encryptedPageAccessToken);
      const response = await axios.get(`https://graph.facebook.com/v19.0/${page.facebookPageId}`, {
        params: { access_token: accessToken, fields: 'id,name' },
        timeout: 10000,
      });
      res.json({ success: true, message: 'Token hợp lệ!', data: response.data });
    } catch (e) {
      if (axios.isAxiosError(e)) {
        return next(new BadRequestError(`Facebook API: ${e.response?.data?.error?.message ?? e.message}`));
      }
      next(e);
    }
  }
);

router.post(
  '/:id/check-token',
  requirePageAccess('canView'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = await prisma.facebookPage.findUnique({ where: { id: req.params.id } });
      if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');
      res.json({ success: true, message: `Token của Page ${page.pageName} ở trạng thái ${page.tokenStatus}` });
    } catch (e) {
      next(e);
    }
  }
);

export default router;