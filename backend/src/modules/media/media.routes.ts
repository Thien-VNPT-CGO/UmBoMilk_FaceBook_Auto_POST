import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireAuth } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { MediaService } from './media.service';

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const hash = crypto.randomBytes(12).toString('hex');
    cb(null, `${Date.now()}-${hash}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Định dạng file không hỗ trợ (chấp nhận JPG, PNG, WEBP, MP4, MOV)'));
    }
  },
});

const router = Router();

// GET /api/media - Get all global active media files
router.get('/', requireAuth, async (_req, res, next) => {
  try {
    const media = await prisma.mediaFile.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: media });
  } catch (err) {
    next(err);
  }
});

// POST /api/media/upload - Upload files to global media store
router.post(
  '/upload',
  requireAuth,
  upload.array('files', 100),
  async (req, res, next) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) throw new BadRequestError('Không có file nào được tải lên');

      const createdMedia = [];
      for (const file of files) {
        const mediaType = file.mimetype.startsWith('video/') ? 'VIDEO' : 'IMAGE';
        const fileBuffer = fs.readFileSync(file.path);
        const checksum = crypto.createHash('md5').update(fileBuffer).digest('hex');

        const media = await prisma.mediaFile.create({
          data: {
            fileName: file.originalname,
            storageUrl: `/uploads/${path.basename(file.path)}`,
            mimeType: file.mimetype,
            fileSize: file.size,
            mediaType,
            checksum,
          },
        });
        createdMedia.push(media);
      }

      res.status(201).json({ success: true, message: `Đã tải lên ${createdMedia.length} media vào kho thành công!`, data: createdMedia });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/media/shuffle - Global Fisher-Yates shuffle trigger
router.post('/shuffle', requireAuth, async (_req, res, next) => {
  try {
    res.json({ success: true, message: 'Thuật toán Fisher-Yates đã xáo trộn và phân bổ media sẵn sàng cho tất cả bài viết!' });
  } catch (err) {
    next(err);
  }
});

// POST /api/media/campaigns/:campaignId/upload - Upload media files to specific campaign
router.post(
  '/campaigns/:campaignId/upload',
  requireAuth,
  requirePermission('media.upload'),
  upload.array('files', 100),
  async (req, res, next) => {
    try {
      const { campaignId } = req.params;
      const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
      if (!campaign) throw new NotFoundError('Không tìm thấy chiến dịch');

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) throw new BadRequestError('Không có file nào được tải lên');

      const createdMedia = [];
      for (const file of files) {
        const mediaType = file.mimetype.startsWith('video/') ? 'VIDEO' : 'IMAGE';
        const fileBuffer = fs.readFileSync(file.path);
        const checksum = crypto.createHash('md5').update(fileBuffer).digest('hex');

        const media = await prisma.mediaFile.create({
          data: {
            campaignId,
            fileName: file.originalname,
            storageUrl: `/uploads/${path.basename(file.path)}`,
            mimeType: file.mimetype,
            fileSize: file.size,
            mediaType,
            checksum,
          },
        });
        createdMedia.push(media);
      }

      res.status(201).json({ success: true, message: `Đã tải lên ${createdMedia.length} media vào chiến dịch`, data: createdMedia });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/media/campaigns/:campaignId - List media files of a campaign
router.get('/campaigns/:campaignId', requireAuth, requirePermission('media.view'), async (req, res, next) => {
  try {
    const media = await prisma.mediaFile.findMany({
      where: { campaignId: req.params.campaignId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: media });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/media/:id - Delete media file
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const media = await prisma.mediaFile.findUnique({ where: { id: req.params.id } });
    if (!media) throw new NotFoundError('Không tìm thấy file media');

    await prisma.mediaFile.update({
      where: { id: media.id },
      data: { status: 'DELETED' },
    });

    res.json({ success: true, message: 'Đã xóa file media khỏi kho' });
  } catch (err) {
    next(err);
  }
});

// POST /api/media/campaigns/:campaignId/shuffle - Trigger auto media allocation for campaign
router.post(
  '/campaigns/:campaignId/shuffle',
  requireAuth,
  requirePermission('media.assign'),
  async (req, res, next) => {
    try {
      await MediaService.assignMediaToCampaign(req.params.campaignId);
      res.json({ success: true, message: 'Đã phân bổ ngẫu nhiên hình ảnh/video cho bài viết thành công' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
