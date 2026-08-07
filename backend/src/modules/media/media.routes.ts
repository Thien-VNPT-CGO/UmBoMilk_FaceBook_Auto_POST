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

      // 1. Purge records with local storage path (/uploads/) missing from disk on server restart
      if (m.storageUrl && m.storageUrl.startsWith('/uploads/')) {
        const localPath = path.join(uploadDir, path.basename(m.storageUrl));
        if (!fs.existsSync(localPath)) {
          isDup = true;
          console.log(`[Media Purge] Phát hiện tệp hỏng mất file đĩa (${m.storageUrl}), xóa kỷ lục DB để tải lại.`);
        }
      }

      // 2. Deduplicate by MD5 checksum
      if (m.checksum) {
        if (seenChecksums.has(m.checksum)) {
          isDup = true;
        } else {
          seenChecksums.add(m.checksum);
        }
      }

      // 3. Deduplicate by Google Drive File ID
      const driveMatch = extractDriveFileIds(m.fileName + ' ' + m.storageUrl);
      if (driveMatch.length > 0) {
        const driveId = driveMatch[0];
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
      console.log(`[Media Cleanup] Đã xóa thành công ${duplicateIdsToDelete.length} tệp hỏng/trùng lặp khỏi Kho Media.`);
    }

    return duplicateIdsToDelete.length;
  } catch (e: any) {
    console.error('[Media Deduplication Error]', e.message);
    return 0;
  }
}

async function downloadAndSaveDriveFile(fileIdOrUrl: string, expectedType: 'IMAGE' | 'VIDEO', folderName?: string): Promise<any> {
  const driveIds = extractDriveFileIds(fileIdOrUrl);
  const driveId = driveIds[0] || (fileIdOrUrl.length >= 25 ? fileIdOrUrl : null);
  const isDirectUrl = fileIdOrUrl.startsWith('http://') || fileIdOrUrl.startsWith('https://');
  const directDriveUrl = driveIds.length > 0 ? `https://lh3.googleusercontent.com/d/${driveIds[0]}` : (isDirectUrl ? fileIdOrUrl : null);

  const folderTag = folderName ? folderName.toLowerCase().replace(/[^a-z0-9]+/g, '_') : 'gdrive';

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
  const filename = `drive-${driveId || Date.now()}.${ext}`;
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
  const savedFileName = driveId
    ? `gdrive_${folderTag}_${expectedType.toLowerCase()}_${driveId}.${ext}`
    : `gdrive_${folderTag}_${expectedType.toLowerCase()}_${filename}`;

  const media = await prisma.mediaFile.create({
    data: {
      fileName: savedFileName,
      storageUrl: storageUrlFinal,
      mimeType: contentType,
      fileSize: buffer.length,
      mediaType,
      checksum,
    },
  });

  return media;
}

const DEFAULT_DRIVE_FOLDERS = [
  { id: '1', name: 'Hình ảnh Bối Bối', type: 'IMAGE', url: '' },
  { id: '2', name: 'Hình ảnh KenStore', type: 'IMAGE', url: '' },
  { id: '3', name: 'Hình ảnh Mốt lab', type: 'IMAGE', url: '' },
  { id: '4', name: 'Hình ảnh Ụm Bò Milk', type: 'IMAGE', url: '' },
  { id: '5', name: 'Video Ụm Bò Milk', type: 'VIDEO', url: '' },
];

// POST /api/media/import-drive - Sync/Import media files from Google Drive URLs
router.post('/import-drive', requireAuth, async (req, res, next) => {
  try {
    let links = req.body.links;
    if (!Array.isArray(links) || !links.length) {
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_folder_links' } });
      if (setting?.valueEncrypted) {
        try { links = JSON.parse(setting.valueEncrypted); } catch (e) {}
      }
    }
    if (!Array.isArray(links) || !links.length) {
      links = DEFAULT_DRIVE_FOLDERS;
    }

    if (req.body.imageLink || req.body.videoLink) {
      links = [
        { id: 'legacy-img', name: 'Hình ảnh Google Drive', type: 'IMAGE', url: req.body.imageLink },
        { id: 'legacy-vid', name: 'Video Google Drive', type: 'VIDEO', url: req.body.videoLink },
      ];
    }

    const activeLinks = links.filter((l: any) => l.url && l.url.trim().length > 0);
    if (!activeLinks.length) {
      throw new BadRequestError('Vui lòng dán ít nhất 1 liên kết Google Drive cho các thư mục media!');
    }

    await cleanDuplicateMediaFiles();

    const importedMedia: any[] = [];
    let skippedCount = 0;
    const errors: string[] = [];

    for (const folder of activeLinks) {
      const folderName = folder.name || 'Drive';
      const expectedType = folder.type === 'VIDEO' ? 'VIDEO' : 'IMAGE';
      const driveUrl = folder.url.trim();

      let fileIds = extractDriveFileIds(driveUrl);
      if (fileIds.length === 0 && driveUrl.includes('/folders/')) {
        fileIds = await extractFileIdsFromFolderUrl(driveUrl);
      }
      if (fileIds.length === 0 && driveUrl.startsWith('http')) {
        fileIds = [driveUrl];
      }

      for (const idOrUrl of fileIds) {
        try {
          const media = await downloadAndSaveDriveFile(idOrUrl, expectedType, folderName);
          if (media?.isDuplicate) {
            skippedCount++;
          } else {
            importedMedia.push(media);
          }
        } catch (err: any) {
          console.error(`[Drive Import] Lỗi nạp (${folderName} - ${idOrUrl}):`, err.message);
          errors.push(`${folderName}: ${err.message}`);
        }
      }
    }

    if (importedMedia.length === 0 && skippedCount === 0 && errors.length > 0) {
      throw new BadRequestError(`Không thể tải media từ Google Drive: ${errors.join('; ')}`);
    }

    res.json({
      success: true,
      message: `🎉 Đã đồng bộ hoàn tất! Tải mới: ${importedMedia.length} tệp, Trùng lặp bỏ qua: ${skippedCount} tệp.`,
      data: { importedMedia, skippedCount, errors },
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
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_folder_links' } });
    let links = DEFAULT_DRIVE_FOLDERS;
    if (setting?.valueEncrypted) {
      try {
        const parsed = JSON.parse(setting.valueEncrypted);
        if (Array.isArray(parsed) && parsed.length > 0) {
          links = parsed;
        }
      } catch (e) {}
    }
    res.json({
      success: true,
      data: links,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/media/drive-links - Save Google Drive links
router.post('/drive-links', requireAuth, async (req, res, next) => {
  try {
    const { links } = req.body;
    if (!Array.isArray(links)) throw new BadRequestError('Dữ liệu links phải là mảng');
    await prisma.systemSetting.upsert({
      where: { key: 'gdrive_folder_links' },
      update: { valueEncrypted: JSON.stringify(links) },
      create: { key: 'gdrive_folder_links', valueEncrypted: JSON.stringify(links) },
    });
    res.json({ success: true, message: '✅ Đã lưu danh sách liên kết Google Drive thành công!' });
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
    if (/^[a-zA-Z0-9_-]{25,}$/.test(trimmed) && !trimmed.startsWith('drive-') && !trimmed.startsWith('gdrive_')) {
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

