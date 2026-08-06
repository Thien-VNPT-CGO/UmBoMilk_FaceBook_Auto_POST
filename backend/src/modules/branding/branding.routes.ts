import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { requireAuth, AuthenticatedRequest } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';

const frontendPublicDir = path.join(process.cwd(), '..', 'frontend', 'public');
if (!fs.existsSync(frontendPublicDir)) {
  fs.mkdirSync(frontendPublicDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, frontendPublicDir),
  filename: (_req, _file, cb) => cb(null, 'logo.jpg'),
});

const upload = multer({ storage });
const router = Router();

// GET /settings/branding - Get current branding info
router.get('/', requireAuth, async (_req, res, next) => {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'branding' } });
    res.json({
      data: setting?.valueJson || {
        systemName: 'UmBoMilk - Marketing Auto-Post Page Facebook',
        copyright: '© 2026. All rights reserved.',
        logoUrl: 'logo.jpg',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /settings/branding/logo - Upload custom logo
router.post('/logo', requireAuth, requirePermission('branding.update'), upload.single('logo'), async (req, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.user?.id || 'system';

    await prisma.systemSetting.upsert({
      where: { key: 'branding' },
      update: {
        valueJson: {
          systemName: req.body.systemName || 'UmBoMilk - Marketing Auto-Post Page Facebook',
          copyright: '© 2026. All rights reserved.',
          logoUrl: 'logo.jpg',
        },
        updatedBy: userId,
      },
      create: {
        key: 'branding',
        valueJson: {
          systemName: req.body.systemName || 'UmBoMilk - Marketing Auto-Post Page Facebook',
          copyright: '© 2026. All rights reserved.',
          logoUrl: 'logo.jpg',
        },
        updatedBy: userId,
      },
    });

    res.json({ message: 'Đã cập nhật logo và nhận diện thương hiệu thành công' });
  } catch (err) {
    next(err);
  }
});

export default router;
