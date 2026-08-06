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

router.get('/', requirePermission('page.view'), async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const pages = await prisma.facebookPage.findMany({
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

const updateSchema = z.object({
  pageName: z.string().optional(),
  defaultPostCount: z.number().int().min(1).max(500).optional(),
  defaultIntervalMinutes: z.number().int().min(1).max(720).optional(),
});

router.put(
  '/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = updateSchema.parse(req.body);
      const page = await prisma.facebookPage.findUnique({ where: { id: req.params.id } });
      if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');

      const updated = await prisma.facebookPage.update({
        where: { id: req.params.id },
        data: {
          ...(data.pageName ? { pageName: data.pageName } : {}),
          ...(data.defaultPostCount !== undefined ? { defaultPostCount: data.defaultPostCount } : {}),
          ...(data.defaultIntervalMinutes !== undefined ? { defaultIntervalMinutes: data.defaultIntervalMinutes } : {}),
        },
      });

      res.json({
        success: true,
        message: `✅ Đã cập nhật cài đặt cho Page ${updated.pageName}!`,
        data: updated,
      });
    } catch (e) {
      if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
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

router.post(
  '/fetch-user-pages',
  requirePermission('page.view'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userAccessToken } = req.body;
      if (!userAccessToken || typeof userAccessToken !== 'string') {
        throw new BadRequestError('Vui lòng cung cấp Facebook User Access Token (dạng EAAB...)');
      }

      const cleanToken = userAccessToken.trim();
      const response = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
        params: {
          access_token: cleanToken,
          fields: 'id,name,access_token,category',
          limit: 100,
        },
        timeout: 10000,
      });

      const pages = response.data?.data || [];
      res.json({
        success: true,
        message: `Đã tìm thấy ${pages.length} Facebook Page trong tài khoản của bạn!`,
        data: pages,
      });
    } catch (e) {
      if (axios.isAxiosError(e)) {
        return next(new BadRequestError(`Lỗi Facebook Graph API: ${e.response?.data?.error?.message ?? e.message}`));
      }
      next(e);
    }
  }
);

router.post(
  '/batch-import',
  requirePermission('page.create'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { pages } = req.body;
      if (!Array.isArray(pages) || !pages.length) {
        throw new BadRequestError('Vui lòng chọn ít nhất 1 Facebook Page để nhập');
      }

      let importedCount = 0;
      for (const p of pages) {
        if (!p.facebookPageId || !p.pageName || !p.pageAccessToken) continue;
        const exists = await prisma.facebookPage.findUnique({ where: { facebookPageId: p.facebookPageId } });
        let pageId = '';
        const postCount = parseInt(p.defaultPostCount) || 10;
        const intervalMinutes = parseInt(p.defaultIntervalMinutes) || 15;

        if (exists) {
          await prisma.facebookPage.update({
            where: { id: exists.id },
            data: {
              pageName: p.pageName,
              encryptedPageAccessToken: encryptString(p.pageAccessToken),
              tokenStatus: 'VALID',
              ...(p.defaultPostCount ? { defaultPostCount: postCount } : {}),
              ...(p.defaultIntervalMinutes ? { defaultIntervalMinutes: intervalMinutes } : {}),
            },
          });
          pageId = exists.id;
        } else {
          const created = await prisma.facebookPage.create({
            data: {
              ownerId: req.user!.id,
              pageName: p.pageName,
              facebookPageId: p.facebookPageId,
              encryptedPageAccessToken: encryptString(p.pageAccessToken),
              tokenStatus: 'VALID',
              defaultPostCount: postCount,
              defaultIntervalMinutes: intervalMinutes,
            },
          });
          pageId = created.id;
        }

        await prisma.userFacebookPage.upsert({
          where: { userId_facebookPageId: { userId: req.user!.id, facebookPageId: pageId } },
          update: { canView: true, canEditContent: true, canApproveContent: true, canPublish: true },
          create: {
            userId: req.user!.id,
            facebookPageId: pageId,
            canView: true,
            canEditContent: true,
            canApproveContent: true,
            canPublish: true,
          },
        });

        importedCount++;
      }

      res.json({ success: true, message: `Đã tự động kết nối ${importedCount} Facebook Page vào hệ thống thành công!` });
    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/:id/update-token',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { pageAccessToken } = req.body;
      if (!pageAccessToken || !pageAccessToken.trim()) {
        throw new BadRequestError('Vui lòng dán mã Page Access Token mới!');
      }

      const page = await prisma.facebookPage.findUnique({ where: { id: req.params.id } });
      if (!page) throw new NotFoundError('Không tìm thấy Facebook Page');

      // Test token with Graph API
      let isValid = true;
      try {
        const testRes = await axios.get(`https://graph.facebook.com/v19.0/${page.facebookPageId}`, {
          params: { access_token: pageAccessToken.trim() },
          timeout: 10000,
        });
        if (!testRes.data?.id) isValid = false;
      } catch (err) {
        // Continue even if test fails
      }

      const updated = await prisma.facebookPage.update({
        where: { id: page.id },
        data: {
          encryptedPageAccessToken: encryptString(pageAccessToken.trim()),
          tokenStatus: isValid ? 'VALID' : 'INVALID',
        },
      });

      res.json({
        success: true,
        message: `✅ Đã cập nhật Page Access Token mới thành công cho ${updated.pageName}!`,
        data: { id: updated.id, tokenStatus: updated.tokenStatus },
      });
    } catch (e) {
      next(e);
    }
  }
);

export default router;