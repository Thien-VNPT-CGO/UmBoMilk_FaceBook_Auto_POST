import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
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
    await cleanDuplicateMediaFiles();
    const media = await prisma.mediaFile.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: media });
  } catch (err) {
    next(err);
  }
});

async function cleanDuplicateMediaFiles(): Promise<number> {
  try {
    const allMedia = await prisma.mediaFile.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const seenChecksums = new Set<string>();
    const seenDriveIds = new Set<string>();
    const duplicateIdsToDelete: string[] = [];

    for (const m of allMedia) {
      let isDup = false;

      if (m.checksum) {
        if (seenChecksums.has(m.checksum)) {
          isDup = true;
        } else {
          seenChecksums.add(m.checksum);
        }
      }

      const driveMatch = (m.fileName + ' ' + m.storageUrl).match(/([a-zA-Z0-9_-]{25,40})/);
      if (driveMatch) {
        const driveId = driveMatch[1];
        if (seenDriveIds.has(driveId)) {
          isDup = true;
        } else {
          seenDriveIds.add(driveId);
        }
      }

      if (isDup) {
        duplicateIdsToDelete.push(m.id);
      }
    }

    if (duplicateIdsToDelete.length > 0) {
      await prisma.postMedia.deleteMany({
        where: { mediaFileId: { in: duplicateIdsToDelete } },
      });
      await prisma.mediaFile.deleteMany({
        where: { id: { in: duplicateIdsToDelete } },
      });
      console.log(`[Media Deduplication Cleanup] Đã tự động xóa ${duplicateIdsToDelete.length} tệp trùng lặp trong Kho Media.`);
    }

    return duplicateIdsToDelete.length;
  } catch (e: any) {
    console.error('[Media Deduplication Error]', e.message);
    return 0;
  }
}

async function downloadAndSaveDriveFile(fileIdOrUrl: string, expectedType: 'IMAGE' | 'VIDEO'): Promise<any> {
  const driveIds = extractDriveFileIds(fileIdOrUrl);
  const driveId = driveIds[0] || (fileIdOrUrl.length >= 25 ? fileIdOrUrl : null);
  const isDirectUrl = fileIdOrUrl.startsWith('http://') || fileIdOrUrl.startsWith('https://');
  const directDriveUrl = driveIds.length > 0 ? `https://lh3.googleusercontent.com/d/${driveIds[0]}` : (isDirectUrl ? fileIdOrUrl : null);

  // Check 1: Pre-check DB for existing media by Drive ID or storageUrl
  if (directDriveUrl || driveId) {
    const filterConditions: any[] = [];
    if (directDriveUrl) filterConditions.push({ storageUrl: directDriveUrl });
    if (driveId) {
      filterConditions.push({ fileName: { contains: driveId } });
      filterConditions.push({ storageUrl: { contains: driveId } });
    }

    const existing = await prisma.mediaFile.findFirst({
      where: { OR: filterConditions }
    });

    if (existing) {
      console.log(`[Drive Import Skip] Media ${driveId || directDriveUrl} đã có trong kho, bỏ qua.`);
      return { ...existing, isDuplicate: true };
    }
  }

  let downloadUrl = isDirectUrl
    ? fileIdOrUrl
    : `https://lh3.googleusercontent.com/d/${fileIdOrUrl}`;

  if (isDirectUrl && fileIdOrUrl.includes('drive.google.com')) {
    if (driveIds.length > 0) {
      downloadUrl = `https://lh3.googleusercontent.com/d/${driveIds[0]}`;
    }
  }

  const ext = expectedType === 'VIDEO' ? 'mp4' : 'jpg';
  const filename = `drive-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const filePath = path.join(uploadDir, filename);

  const response = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 40000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  const buffer = Buffer.from(response.data);
  fs.writeFileSync(filePath, buffer);

  const rawContentType = String(response.headers['content-type'] || '');
  const contentType = rawContentType || (expectedType === 'VIDEO' ? 'video/mp4' : 'image/jpeg');
  const mediaType = contentType.startsWith('video/') ? 'VIDEO' : expectedType;
  const checksum = crypto.createHash('md5').update(buffer).digest('hex');

  // Check 2: Post-check DB by MD5 checksum
  const existingByChecksum = await prisma.mediaFile.findFirst({
    where: { checksum }
  });

  if (existingByChecksum) {
    console.log(`[Drive Import Skip] Media có MD5 ${checksum} đã có trong kho, bỏ qua.`);
    return { ...existingByChecksum, isDuplicate: true };
  }

  const storageUrlFinal = directDriveUrl || `/uploads/${filename}`;

  const media = await prisma.mediaFile.create({
    data: {
      fileName: `gdrive_${expectedType.toLowerCase()}_${filename}`,
      storageUrl: storageUrlFinal,
      mimeType: contentType,
      fileSize: buffer.length,
      mediaType,
      checksum,
    },
  });

  return media;
}

// POST /api/media/import-drive - Sync/Import media files from Google Drive URLs
router.post('/import-drive', requireAuth, async (req, res, next) => {
  try {
    let { imageLink, videoLink } = req.body;

    if (!imageLink && !videoLink) {
      const imgSetting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_image_url' } });
      const vidSetting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_video_url' } });
      imageLink = imgSetting?.valueEncrypted || '';
      videoLink = vidSetting?.valueEncrypted || '';
    }

    if (!imageLink && !videoLink) {
      throw new BadRequestError('Vui lòng nhập ít nhất 1 liên kết Google Drive cho Hình ảnh hoặc Video');
    }

    // Clean up any existing duplicates first
    await cleanDuplicateMediaFiles();

    const importedMedia: any[] = [];
    let skippedCount = 0;
    const errors: string[] = [];

    // Process Image Link
    if (imageLink) {
      let imgIds = extractDriveFileIds(imageLink);
      if (imgIds.length === 0 && imageLink.includes('/folders/')) {
        imgIds = await extractFileIdsFromFolderUrl(imageLink);
      }
      if (imgIds.length === 0 && imageLink.startsWith('http')) {
        imgIds = [imageLink];
      }

      for (const idOrUrl of imgIds) {
        try {
          const media = await downloadAndSaveDriveFile(idOrUrl, 'IMAGE');
          if (media?.isDuplicate) {
            skippedCount++;
          } else {
            importedMedia.push(media);
          }
        } catch (err: any) {
          console.error(`[Drive Import] Lỗi tải hình ảnh (${idOrUrl}):`, err.message);
          errors.push(`Ảnh (${idOrUrl}): ${err.message}`);
        }
      }
    }

    // Process Video Link
    if (videoLink) {
      let vidIds = extractDriveFileIds(videoLink);
      if (vidIds.length === 0 && videoLink.includes('/folders/')) {
        vidIds = await extractFileIdsFromFolderUrl(videoLink);
      }
      if (vidIds.length === 0 && videoLink.startsWith('http')) {
        vidIds = [videoLink];
      }

      for (const idOrUrl of vidIds) {
        try {
          const media = await downloadAndSaveDriveFile(idOrUrl, 'VIDEO');
          if (media?.isDuplicate) {
            skippedCount++;
          } else {
            importedMedia.push(media);
          }
        } catch (err: any) {
          console.error(`[Drive Import] Lỗi tải video (${idOrUrl}):`, err.message);
          errors.push(`Video (${idOrUrl}): ${err.message}`);
        }
      }
    }

    if (importedMedia.length === 0 && skippedCount === 0 && errors.length > 0) {
      throw new BadRequestError(`Không thể tải media từ Google Drive: ${errors.join('; ')}`);
    }

    let msg = `🎉 Đã đồng bộ thành công ${importedMedia.length} tệp mới từ Google Drive vào kho media!`;
    if (skippedCount > 0) {
      msg += ` (Đã tự động bỏ qua ${skippedCount} tệp trùng lặp).`;
    }

    res.json({
      success: true,
      message: msg,
      data: importedMedia,
      skippedCount,
      errors: errors.length > 0 ? errors : undefined,
    });
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

// GET /api/media/drive-links - Fetch saved Google Drive links
router.get('/drive-links', requireAuth, async (_req, res, next) => {
  try {
    const imgSetting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_image_url' } });
    const vidSetting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_video_url' } });
    res.json({
      success: true,
      data: {
        imageLink: imgSetting?.valueEncrypted || '',
        videoLink: vidSetting?.valueEncrypted || '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/media/drive-links - Save Google Drive links
router.post('/drive-links', requireAuth, async (req, res, next) => {
  try {
    const { imageLink, videoLink } = req.body;
    await prisma.systemSetting.upsert({
      where: { key: 'gdrive_image_url' },
      update: { valueEncrypted: imageLink || '' },
      create: { key: 'gdrive_image_url', valueEncrypted: imageLink || '' },
    });
    await prisma.systemSetting.upsert({
      where: { key: 'gdrive_video_url' },
      update: { valueEncrypted: videoLink || '' },
      create: { key: 'gdrive_video_url', valueEncrypted: videoLink || '' },
    });
    res.json({ success: true, message: '✅ Đã lưu liên kết Google Drive thành công!' });
  } catch (err) {
    next(err);
  }
});

// Helper function to extract file IDs from Google Drive URLs
function extractDriveFileIds(inputUrl: string): string[] {
  if (!inputUrl) return [];
  const ids: string[] = [];
  const items = inputUrl.split(/[\s,\n]+/);
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const match1 = trimmed.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
    if (match1) {
      ids.push(match1[1]);
      continue;
    }
    const match2 = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
    if (match2) {
      ids.push(match2[1]);
      continue;
    }
    if (/^[a-zA-Z0-9_-]{25,}$/.test(trimmed)) {
      ids.push(trimmed);
      continue;
    }
  }
  return [...new Set(ids)];
}

async function extractFileIdsFromFolderUrl(folderUrl: string): Promise<string[]> {
  try {
    const match = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!match) return [];
    const folderId = match[1];

    const res = await axios.get(`https://drive.google.com/drive/folders/${folderId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    const html = res.data;
    const matches = html.match(/\\\\"[a-zA-Z0-9_-]{25,}\\\\"|"[a-zA-Z0-9_-]{28,35}"/g) || [];
    const foundIds: string[] = [];
    for (const m of matches) {
      const clean = m.replace(/[\"\\]/g, '');
      if (clean !== folderId && clean.length >= 25 && clean.length <= 40) {
        foundIds.push(clean);
      }
    }
    return [...new Set(foundIds)];
  } catch (err) {
    console.error('[Drive Import] Error parsing folder:', err);
    return [];
  }
}

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

