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
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BadRequestError('Định dạng file không hỗ trợ (chấp nhận JPG, PNG, WEBP, MP4, MOV)'));
    }
  },
});

const router = Router();

// 1. Upload media files to campaign
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

      res.status(201).json({ message: `Đã tải lên ${createdMedia.length} media`, data: createdMedia });
    } catch (err) {
      next(err);
    }
  }
);

// 2. List media files of a campaign
router.get('/campaigns/:campaignId', requireAuth, requirePermission('media.view'), async (req, res, next) => {
  try {
    const media = await prisma.mediaFile.findMany({
      where: { campaignId: req.params.campaignId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ data: media });
  } catch (err) {
    next(err);
  }
});

// 3. Delete media file
router.delete('/:id', requireAuth, requirePermission('media.delete'), async (req, res, next) => {
  try {
    const media = await prisma.mediaFile.findUnique({ where: { id: req.params.id } });
    if (!media) throw new NotFoundError('Không tìm thấy file media');

    // Check if media is attached to a published or scheduled post
    const attached = await prisma.postMedia.findFirst({
      where: {
        mediaFileId: media.id,
        generatedPost: { status: { in: ['SCHEDULED', 'PUBLISHED'] } },
      },
    });

    if (attached) {
      throw new BadRequestError('Không thể xóa media đang gắn với bài viết đã lên lịch hoặc đã đăng');
    }

    await prisma.mediaFile.update({
      where: { id: media.id },
      data: { status: 'DELETED' },
    });

    res.json({ message: 'Đã xóa file media' });
  } catch (err) {
    next(err);
  }
});

// 4. Trigger auto media allocation (Fisher-Yates shuffle)
router.post(
  '/campaigns/:campaignId/shuffle',
  requireAuth,
  requirePermission('media.assign'),
  async (req, res, next) => {
    try {
      await MediaService.assignMediaToCampaign(req.params.campaignId);
      res.json({ message: 'Đã phân bổ ngẫu nhiên hình ảnh/video cho bài viết thành công' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
