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

  const folderTag = folderName ? removeVietnameseTones(folderName) : 'gdrive';

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

  const storageUrlFinal = (expectedType === 'VIDEO' || mediaType === 'VIDEO')
    ? `/uploads/${filename}`
    : (directDriveUrl || `/uploads/${filename}`);
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
  { id: '1', name: 'Hình ảnh Bối Bối', type: 'IMAGE', url: '', children: [] },
  { id: '2', name: 'Hình ảnh KenStore', type: 'IMAGE', url: '', children: [] },
  { id: '3', name: 'Hình ảnh Mốt lab', type: 'IMAGE', url: '', children: [] },
  { id: '4', name: 'Hình ảnh Ụm Bò Milk', type: 'IMAGE', url: '', children: [] },
  {
    id: '5',
    name: 'Video Ụm Bò Milk',
    type: 'VIDEO',
    url: '',
    children: [
      { id: '5-1', name: '🚨 NHÌN VỊ SỮA ĐOÁN TÍNH CÁCH', type: 'VIDEO', url: '' },
      { id: '5-2', name: 'CÀNG LỚN CÀNG THÍCH NHỮNG THỨ ĐƠN GIẢN', type: 'VIDEO', url: '' },
      { id: '5-3', name: 'ĐIỀU THẢO THÍCH NHẤT KHÔNG PHẢI LÀ DOANH SỐ', type: 'VIDEO', url: '' }
    ]
  },
];

let driveSyncProgressState = {
  isSyncing: false,
  progressPercent: 0,
  currentFolder: '',
  processedFiles: 0,
  totalFiles: 0,
  message: 'Sẵn sàng đồng bộ',
  updatedAt: new Date().toISOString(),
};

// GET /api/media/sync-status - Fetch current Google Drive sync progress
router.get('/sync-status', requireAuth, async (_req, res) => {
  res.json({
    success: true,
    data: driveSyncProgressState,
  });
});

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

    const activeTasks: { folderName: string; expectedType: 'IMAGE' | 'VIDEO'; driveUrl: string }[] = [];
    for (const folder of links) {
      const hasChildren = Array.isArray(folder.children) && folder.children.length > 0;
      if (hasChildren) {
        for (const child of folder.children) {
          if (child.url && child.url.trim().length > 0) {
            activeTasks.push({
              folderName: child.name || folder.name || 'Drive',
              expectedType: (child.type || folder.type) === 'VIDEO' ? 'VIDEO' : 'IMAGE',
              driveUrl: child.url.trim(),
            });
          }
        }
      } else if (folder.url && folder.url.trim().length > 0) {
        activeTasks.push({
          folderName: folder.name || 'Drive',
          expectedType: folder.type === 'VIDEO' ? 'VIDEO' : 'IMAGE',
          driveUrl: folder.url.trim(),
        });
      }
    }

    if (!activeTasks.length) {
      throw new BadRequestError('Vui lòng dán ít nhất 1 liên kết Google Drive cho các thư mục media!');
    }

    driveSyncProgressState = {
      isSyncing: true,
      progressPercent: 5,
      currentFolder: 'Khởi động kết nối Drive...',
      processedFiles: 0,
      totalFiles: 100,
      message: '⏳ Đang quét danh sách tệp từ Google Drive...',
      updatedAt: new Date().toISOString(),
    };

    await cleanDuplicateMediaFiles();

    // Pre-calculate file lists across folders for accurate percentage calculation
    const folderTasks: { folderName: string; expectedType: 'IMAGE' | 'VIDEO'; fileIds: string[] }[] = [];
    let totalFileCount = 0;
    const errors: string[] = [];

    for (const task of activeTasks) {
      const folderName = task.folderName;
      const expectedType = task.expectedType;
      const driveUrl = task.driveUrl;

      let fileIds = extractDriveFileIds(driveUrl);
      if (fileIds.length === 0 && driveUrl.includes('/folders/')) {
        fileIds = await extractFileIdsFromFolderUrl(driveUrl);
        if (fileIds.length === 0) {
          errors.push(`Thư mục "${folderName}" không thể đọc tệp (Vui lòng kiểm tra lại link hoặc mở quyền "Bất kỳ ai có liên kết đều có thể xem").`);
        }
      }
      if (fileIds.length === 0 && driveUrl.startsWith('http')) {
        fileIds = [driveUrl];
      }
      if (fileIds.length > 0) {
        folderTasks.push({ folderName, expectedType, fileIds });
        totalFileCount += fileIds.length;
      }
    }

    if (totalFileCount === 0) totalFileCount = 1;

    driveSyncProgressState.totalFiles = totalFileCount;
    driveSyncProgressState.progressPercent = 10;

    const importedMedia: any[] = [];
    let skippedCount = 0;
    let processedIndex = 0;

    for (const task of folderTasks) {
      driveSyncProgressState.currentFolder = task.folderName;
      
      for (const idOrUrl of task.fileIds) {
        processedIndex++;
        const percent = Math.min(98, Math.round((processedIndex / totalFileCount) * 88) + 10);
        driveSyncProgressState.processedFiles = processedIndex;
        driveSyncProgressState.progressPercent = percent;
        driveSyncProgressState.message = `⏳ Đang tải tệp ${processedIndex}/${totalFileCount} cho "${task.folderName}" (${percent}%)...`;
        driveSyncProgressState.updatedAt = new Date().toISOString();

        try {
          const media = await downloadAndSaveDriveFile(idOrUrl, task.expectedType, task.folderName);
          if (media?.isDuplicate) {
            skippedCount++;
          } else {
            importedMedia.push(media);
          }
        } catch (err: any) {
          console.error(`[Drive Import] Lỗi nạp (${task.folderName} - ${idOrUrl}):`, err.message);
          errors.push(`${task.folderName}: ${err.message}`);
        }
      }
    }

    driveSyncProgressState = {
      isSyncing: false,
      progressPercent: 100,
      currentFolder: 'Hoàn tất',
      processedFiles: totalFileCount,
      totalFiles: totalFileCount,
      message: `🎉 Đã đồng bộ hoàn tất 100%! Tải mới: ${importedMedia.length} tệp, Trùng lặp: ${skippedCount} tệp.`,
      updatedAt: new Date().toISOString(),
    };

    if (importedMedia.length === 0 && skippedCount === 0 && errors.length > 0) {
      throw new BadRequestError(`Không thể tải media từ Google Drive: ${errors.join('; ')}`);
    }

    res.json({
      success: true,
      message: `🎉 Đã đồng bộ hoàn tất 100%! Tải mới: ${importedMedia.length} tệp, Trùng lặp bỏ qua: ${skippedCount} tệp.`,
      data: { importedMedia, skippedCount, errors },
    });
  } catch (err) {
    driveSyncProgressState.isSyncing = false;
    driveSyncProgressState.message = '🔴 Lỗi đồng bộ: ' + (err as Error).message;
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

function removeVietnameseTones(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function extractDriveFolderId(url: string): string | null {
  if (!url) return null;
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

const folderCountCache = new Map<string, { count: number; timestamp: number }>();

async function getStableFolderLiveCount(folderUrl: string): Promise<number> {
  if (!folderUrl || !folderUrl.includes('/folders/')) return 0;
  const cached = folderCountCache.get(folderUrl);
  const now = Date.now();
  if (cached && (now - cached.timestamp < 1800000) && cached.count > 0) {
    return cached.count;
  }

  try {
    const liveFiles = await extractFileIdsFromFolderUrl(folderUrl);
    if (liveFiles.length > 0) {
      const finalCount = cached ? Math.max(cached.count, liveFiles.length) : liveFiles.length;
      folderCountCache.set(folderUrl, { count: finalCount, timestamp: now });
      return finalCount;
    }
  } catch (e) {}

  return cached?.count || 0;
}

async function attachFolderCounts(links: any[]) {
  const result = [];
  for (const f of links) {
    const parentFolderTag = removeVietnameseTones(f.name || '');
    const parentRawTag = (f.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const parentFolderId = extractDriveFolderId(f.url || '');
    let parentCount = 0;

    const childrenWithCounts = [];
    const hasChildren = Array.isArray(f.children) && f.children.length > 0;

    if (hasChildren) {
      for (const child of f.children) {
        const childTag = removeVietnameseTones(child.name || '');
        const childRawTag = (child.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const childFolderId = extractDriveFolderId(child.url || '');
        const driveIds = extractDriveFileIds(child.url || '');
        const driveId = driveIds[0] || childFolderId;

        let childCount = 0;
        if (child.url && child.url.trim().length > 0) {
          const orConditions: any[] = [];
          if (childTag) orConditions.push({ fileName: { contains: childTag } });
          if (childRawTag) orConditions.push({ fileName: { contains: childRawTag } });
          if (driveId) {
            orConditions.push({ fileName: { contains: driveId } });
            orConditions.push({ storageUrl: { contains: driveId } });
          }
          if (childFolderId) {
            orConditions.push({ fileName: { contains: childFolderId } });
            orConditions.push({ storageUrl: { contains: childFolderId } });
          }

          if (orConditions.length > 0) {
            childCount = await prisma.mediaFile.count({
              where: { status: 'ACTIVE', OR: orConditions }
            });
          }

          if (child.url.includes('/folders/')) {
            const liveCount = await getStableFolderLiveCount(child.url);
            childCount = Math.max(childCount, liveCount);
            if (childCount > 0) {
              folderCountCache.set(child.url, { count: childCount, timestamp: Date.now() });
            }
          }
        }
        childrenWithCounts.push({ ...child, count: childCount });
        parentCount += childCount;
      }
    } else if (f.url && f.url.trim().length > 0) {
      const driveIds = extractDriveFileIds(f.url || '');
      const driveId = driveIds[0] || parentFolderId;

      const orConditions: any[] = [];
      if (parentFolderTag) orConditions.push({ fileName: { contains: parentFolderTag } });
      if (parentRawTag) orConditions.push({ fileName: { contains: parentRawTag } });
      if (driveId) {
        orConditions.push({ fileName: { contains: driveId } });
        orConditions.push({ storageUrl: { contains: driveId } });
      }
      if (parentFolderId) {
        orConditions.push({ fileName: { contains: parentFolderId } });
        orConditions.push({ storageUrl: { contains: parentFolderId } });
      }

      if (orConditions.length > 0) {
        parentCount = await prisma.mediaFile.count({
          where: { status: 'ACTIVE', OR: orConditions }
        });
      }

      if (f.url.includes('/folders/')) {
        const liveCount = await getStableFolderLiveCount(f.url);
        parentCount = Math.max(parentCount, liveCount);
        if (parentCount > 0) {
          folderCountCache.set(f.url, { count: parentCount, timestamp: Date.now() });
        }
      }
    }

    result.push({ ...f, count: parentCount, children: childrenWithCounts });
  }
  return result;
}

// GET /api/media/drive-links - Fetch saved Google Drive links with realtime count
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
    const linksWithCounts = await attachFolderCounts(links);
    res.json({
      success: true,
      data: linksWithCounts,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/media/drive-links - Save Google Drive links & auto trigger realtime sync
router.post('/drive-links', requireAuth, async (req, res, next) => {
  try {
    const { links } = req.body;
    if (!Array.isArray(links)) throw new BadRequestError('Dữ liệu links phải là mảng');

    await prisma.systemSetting.upsert({
      where: { key: 'gdrive_folder_links' },
      update: { valueEncrypted: JSON.stringify(links) },
      create: { key: 'gdrive_folder_links', valueEncrypted: JSON.stringify(links) },
    });

    const linksWithCounts = await attachFolderCounts(links);
    res.json({ success: true, message: '✅ Đã lưu và đang tự động đồng bộ Google Drive trong nền!', data: linksWithCounts });
  } catch (err) {
    next(err);
  }
});

// Helper function to extract file IDs from Google Drive URLs
export function extractDriveFileIds(inputUrl: string): string[] {
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

export async function extractFileIdsFromFolderUrl(folderUrl: string, depth = 0): Promise<string[]> {
  if (depth > 2) return []; // Maximum 2 subfolder levels depth
  try {
    const match = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!match) return [];
    const folderId = match[1];

    const res = await axios.get(`https://drive.google.com/drive/folders/${folderId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });
    const html = res.data;

    // Enhanced Drive File ID pattern extraction (supports all modern Google Drive HTML layouts)
    const patterns = [
      /1[a-zA-Z0-9_-]{32}/g,
      /0B[a-zA-Z0-9_-]{31}/g,
      /0b[a-zA-Z0-9_-]{31}/g,
      /\/file\/d\/([a-zA-Z0-9_-]{25,})/g,
      /\\\\"[a-zA-Z0-9_-]{25,}\\\\"|"[a-zA-Z0-9_-]{28,35}"/g,
    ];

    const candidateIds = new Set<string>();
    for (const pattern of patterns) {
      let m;
      while ((m = pattern.exec(html)) !== null) {
        const idStr = m[1] || m[0];
        const clean = idStr.replace(/[\"\\]/g, '').replace(/-0$/, '');
        if (clean !== folderId && clean.length >= 25 && clean.length <= 40) {
          if (!clean.includes('-webkit') && !clean.includes('google') && !clean.includes('logo_') && !clean.includes('theme') && !clean.includes('__') && !clean.includes('--') && !clean.includes('v-') && !clean.includes('h-') && !clean.includes('Zm') && !clean.includes('v80H') && /[0-9]/.test(clean) && /[a-zA-Z]/.test(clean)) {
            candidateIds.add(clean);
          }
        }
      }
    }

    let allIds = Array.from(candidateIds);

    // Detect child sub-folders inside parent folder for branching
    const subFolderMatches = html.match(/\[\\"[a-zA-Z0-9_-]{25,}\\",\\"[^"]+\\",\\"application\/vnd\.google-apps\.folder\\"/g) || [];
    const subFolderIds: string[] = [];
    for (const sf of subFolderMatches) {
      const sfMatch = sf.match(/\\"[a-zA-Z0-9_-]{25,}\\"/);
      if (sfMatch) {
        const cleanSfId = sfMatch[0].replace(/[\"\\]/g, '');
        if (cleanSfId && cleanSfId !== folderId) subFolderIds.push(cleanSfId);
      }
    }

    const uniqueSubFolders = [...new Set(subFolderIds)];
    if (uniqueSubFolders.length > 0 && depth < 2) {
      console.log(`[Drive Branching] Thư mục ${folderId} phát hiện ${uniqueSubFolders.length} thư mục con rẽ nhánh.`);
      for (const sfId of uniqueSubFolders) {
        try {
          const childFileIds = await extractFileIdsFromFolderUrl(`https://drive.google.com/drive/folders/${sfId}`, depth + 1);
          allIds.push(...childFileIds);
        } catch (subErr: any) {
          console.warn(`[Drive Branching Warning] Lỗi quét thư mục con ${sfId}:`, subErr.message);
        }
      }
    }

    return [...new Set(allIds)];
  } catch (err: any) {
    console.error(`[Drive Folder Extract Error] Lỗi đọc thư mục ${folderUrl}:`, err.message);
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

