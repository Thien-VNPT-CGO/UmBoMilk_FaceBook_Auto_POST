import { Worker } from 'bullmq';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { redisConnection } from '../common/redis/redis';
import { prisma } from '../common/database/prisma';
import { logger } from '../common/utils/logger';
import { decryptString } from '../common/encryption/crypto';
import { facebookPublishingQueue } from '../common/queue/queues';

import FormData from 'form-data';

interface PostSchedulingJob {
  postId: string;
}

async function downloadDriveVideoBuffer(driveId: string): Promise<Buffer> {
  const downloadUrls = [
    `https://drive.usercontent.google.com/download?id=${driveId}&export=download&authuser=0&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${driveId}&confirm=t`,
    `https://docs.google.com/uc?export=download&id=${driveId}&confirm=t`,
    `https://lh3.googleusercontent.com/d/${driveId}`,
  ];

  let lastError: Error | null = null;

  for (const url of downloadUrls) {
    try {
      const resp = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 180000,
        maxRedirects: 10,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': '*/*',
        },
      });

      const buf = Buffer.from(resp.data);
      const sampleText = buf.toString('utf8', 0, 300).toLowerCase();

      // Check if response is HTML error/confirmation page
      if (sampleText.includes('<!doctype html') || sampleText.includes('<html') || sampleText.includes('google.com/accounts')) {
        const confirmMatch = sampleText.match(/confirm=([a-zA-Z0-9_-]+)/i);
        if (confirmMatch && confirmMatch[1]) {
          const confirmToken = confirmMatch[1];
          const confirmUrl = `https://drive.usercontent.google.com/download?id=${driveId}&export=download&authuser=0&confirm=${confirmToken}`;
          const confirmResp = await axios.get(confirmUrl, {
            responseType: 'arraybuffer',
            timeout: 180000,
            maxRedirects: 10,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
          });
          const confirmBuf = Buffer.from(confirmResp.data);
          const confirmSample = confirmBuf.toString('utf8', 0, 300).toLowerCase();
          if (!confirmSample.includes('<!doctype html') && !confirmSample.includes('<html')) {
            return confirmBuf;
          }
        }
        continue;
      }

      if (buf.length > 10000) {
        return buf;
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  throw new Error(`Không thể tải file video MP4 từ Google Drive (ID: ${driveId}). Chi tiết lỗi: ${lastError?.message || 'Tất cả phương thức download đều thất bại - Vui lòng kiểm tra quyền chia sẻ file "Bất kỳ ai có liên kết đều có thể xem"'}`);
}

function isValidVideoFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  if (stat.size < 10000) return false;

  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(200);
    fs.readSync(fd, buffer, 0, 200, 0);
    fs.closeSync(fd);

    const sample = buffer.toString('utf8').toLowerCase();
    if (sample.includes('<!doctype html') || sample.includes('<html') || sample.includes('<body') || sample.includes('google.com')) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

function extractDriveFileIds(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]{25,})/g,
    /id=([a-zA-Z0-9_-]{25,})/g,
    /lh3\.googleusercontent\.com\/d\/([a-zA-Z0-9_-]{25,})/g,
    /gdrive_[a-z0-9_]+_video_([a-zA-Z0-9_-]{25,})/g,
    /gdrive_[a-z0-9_]+_image_([a-zA-Z0-9_-]{25,})/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return Array.from(ids);
}

function getPublicMediaUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  const publicBase = process.env.APP_URL || 'https://umbomilk-facebook-auto-post.onrender.com';
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
    if (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1')) {
      return rawUrl.replace(/http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, publicBase);
    }
    return rawUrl;
  }
  return `${publicBase.replace(/\/+$/, '')}/${rawUrl.replace(/^\/+/, '')}`;
}

export async function publishPost(postId: string) {
  // ATOMIC LOCK: Atomically update status to 'PUBLISHING' to prevent concurrent duplicate publishing
  const lockResult = await prisma.generatedPost.updateMany({
    where: {
      id: postId,
      status: { in: ['APPROVED', 'SCHEDULED', 'RETRYING', 'PENDING', 'PENDING_APPROVAL'] },
    },
    data: {
      status: 'PUBLISHING',
    },
  });

  if (lockResult.count === 0) {
    const existing = await prisma.generatedPost.findUnique({ where: { id: postId } });
    if (existing?.status === 'PUBLISHED') {
      logger.info(`[Publish Lock] Post ${postId} is already PUBLISHED. Skipping duplicate execution.`);
      return;
    }
    if (existing?.status === 'PUBLISHING') {
      logger.info(`[Publish Lock] Post ${postId} is currently being published by another worker. Skipping duplicate execution.`);
      return;
    }
  }

  const post = await prisma.generatedPost.findUnique({
    where: { id: postId },
    include: {
      campaignPage: { include: { facebookPage: true } },
      postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
    },
  });

  if (!post) throw new Error('Bài viết không tồn tại');
  if (post.status === 'PUBLISHED') {
    logger.info(`Post ${postId} already published. Skipping (Idempotency check).`);
    return;
  }

  const page = post.campaignPage.facebookPage;
  if (!page.isActive || page.tokenStatus !== 'VALID') {
    throw new Error(`Page ${page.pageName} (${page.facebookPageId}) không hoạt động hoặc Token bị lỗi.`);
  }

  // Fallback: If post has no media assigned, auto-assign from Kho Media right before publishing
  if (!post.postMedias || post.postMedias.length === 0 || (post.mediaType === 'VIDEO' && !post.postMedias.some(pm => pm.mediaFile?.mediaType === 'VIDEO'))) {
    try {
      const { MediaService } = await import('../modules/media/media.service');
      await MediaService.assignMediaToCampaign(post.campaignId);
      let refetchedPost = await prisma.generatedPost.findUnique({
        where: { id: postId },
        include: {
          postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        },
      });
      if (refetchedPost?.postMedias) {
        post.postMedias = refetchedPost.postMedias;
      }

      // If still missing a VIDEO file for a VIDEO post, find ANY active VIDEO in Kho Media
      if (post.mediaType === 'VIDEO' && !post.postMedias.some(pm => pm.mediaFile?.mediaType === 'VIDEO')) {
        const activeVideo = await prisma.mediaFile.findFirst({
          where: { mediaType: 'VIDEO', status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' }
        });
        if (activeVideo) {
          await prisma.postMedia.deleteMany({ where: { generatedPostId: postId } });
          const createdPm = await prisma.postMedia.create({
            data: { generatedPostId: postId, mediaFileId: activeVideo.id, sortOrder: 0 },
            include: { mediaFile: true }
          });
          post.postMedias = [createdPm];
        }
      }
    } catch (e) {
      logger.warn(`Auto-assigning media before publishing failed: ${(e as Error).message}`);
    }
  }

  const accessToken = decryptString(page.encryptedPageAccessToken);
  const videoMediaItem = post.postMedias?.find(pm => pm.mediaFile?.mediaType === 'VIDEO');
  const mediaCount = post.postMedias?.length || 0;
  let facebookPostId: string | null = null;

  try {
    if (post.mediaType === 'VIDEO' && videoMediaItem) {
      // 1. Post Video: Ensure raw video MP4 file is downloaded & verified
      const mediaFile = videoMediaItem.mediaFile;
      let storageUrl = mediaFile.storageUrl || '';

      const uploadDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      const driveMatch = extractDriveFileIds(storageUrl + ' ' + mediaFile.fileName);
      const driveId = driveMatch[0];

      let localFileName = `video-${mediaFile.id}.mp4`;
      if (storageUrl.startsWith('/uploads/')) {
        localFileName = path.basename(storageUrl);
      } else if (driveId) {
        localFileName = `drive-${driveId}.mp4`;
      }

      const localFilePath = path.join(uploadDir, localFileName);

      // Check if local file is valid MP4 video. If invalid/missing/HTML, re-download from Google Drive
      if (!isValidVideoFile(localFilePath)) {
        logger.info(`[Video Publish] Đang tải & kiểm định tệp video MP4 chuẩn từ Drive (ID: ${driveId || storageUrl})...`);
        if (driveId) {
          const videoBuf = await downloadDriveVideoBuffer(driveId);
          fs.writeFileSync(localFilePath, videoBuf);
          logger.info(`[Video Publish] Đã tải & ghi đĩa tệp MP4 chuẩn (${videoBuf.length} bytes).`);
        } else if (storageUrl.startsWith('http')) {
          const resp = await axios.get(storageUrl, {
            responseType: 'arraybuffer',
            timeout: 120000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });
          const videoBuf = Buffer.from(resp.data);
          fs.writeFileSync(localFilePath, videoBuf);
        }
      }

      const newStorageUrl = `/uploads/${localFileName}`;
      if (mediaFile.storageUrl !== newStorageUrl) {
        await prisma.mediaFile.update({
          where: { id: mediaFile.id },
          data: { storageUrl: newStorageUrl }
        }).catch(() => {});
      }

      const videoUrl = getPublicMediaUrl(newStorageUrl);
      logger.info(`[Video Publish] Đang tải video MP4 trực tiếp lên Facebook Graph API (File: ${localFileName}, URL: ${videoUrl})...`);

      // Try Direct Multipart FormData Binary Upload first for 100% playable Facebook videos
      try {
        const formData = new FormData();
        formData.append('access_token', accessToken);
        formData.append('description', post.content);
        formData.append('source', fs.createReadStream(localFilePath));

        const res = await axios.post(
          `https://graph.facebook.com/v19.0/${page.facebookPageId}/videos`,
          formData,
          {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            timeout: 300000,
          }
        );
        facebookPostId = res.data?.id?.toString() ?? null;
        logger.info(`[Video Publish Success] Đã đăng video trực tiếp lên FB Page thành công! FB Video ID: ${facebookPostId}`);
      } catch (uploadErr: any) {
        logger.warn(`[Video Direct Upload Warning] Direct stream upload failed, falling back to file_url: ${uploadErr.message}`);
        // Fallback to file_url if direct stream failed
        const res = await axios.post(
          `https://graph.facebook.com/v19.0/${page.facebookPageId}/videos`,
          null,
          {
            params: {
              access_token: accessToken,
              description: post.content,
              file_url: videoUrl,
            },
            timeout: 120000,
          }
        );
        facebookPostId = res.data?.id?.toString() ?? null;
      }
    } else if (mediaCount > 1) {
      // 2. Post Multi-Photo Album (e.g. 6 Photos)
      const attachedMediaIds: string[] = [];
      const photoErrors: string[] = [];

      for (const pm of post.postMedias) {
        try {
          const photoUrl = getPublicMediaUrl(pm.mediaFile.storageUrl);
          const photoRes = await axios.post(
            `https://graph.facebook.com/v19.0/${page.facebookPageId}/photos`,
            null,
            {
              params: {
                access_token: accessToken,
                url: photoUrl,
                published: false,
              },
              timeout: 25000,
            }
          );
          if (photoRes.data?.id) {
            attachedMediaIds.push(photoRes.data.id);
          }
        } catch (err: any) {
          logger.warn(`[Photo Upload Warning] Lỗi tải 1 hình ảnh lên FB: ${err.message}`);
          photoErrors.push(err.message);
        }
      }

      if (attachedMediaIds.length === 0) {
        throw new Error(`Không thể đăng bộ ảnh lên Facebook Page (Lỗi tải ảnh: ${photoErrors.join('; ') || 'URL ảnh không thể truy cập từ máy chủ Facebook'}).`);
      }

      const feedParams: Record<string, unknown> = {
        access_token: accessToken,
        message: post.content,
      };
      attachedMediaIds.forEach((id, idx) => {
        feedParams[`attached_media[${idx}]`] = JSON.stringify({ media_fbid: id });
      });

      const feedRes = await axios.post(
        `https://graph.facebook.com/v19.0/${page.facebookPageId}/feed`,
        null,
        { params: feedParams, timeout: 25000 }
      );
      facebookPostId = feedRes.data?.id?.toString() ?? null;
    } else if (mediaCount === 1) {
      // 3. Single Photo Post
      const photoUrl = getPublicMediaUrl(post.postMedias[0].mediaFile.storageUrl);
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${page.facebookPageId}/photos`,
        null,
        {
          params: {
            access_token: accessToken,
            caption: post.content,
            url: photoUrl,
          },
          timeout: 25000,
        }
      );
      facebookPostId = res.data?.id?.toString() ?? null;
    } else {
      // 4. Text-only Post
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${page.facebookPageId}/feed`,
        null,
        {
          params: {
            access_token: accessToken,
            message: post.content,
          },
          timeout: 15000,
        }
      );
      facebookPostId = res.data?.id?.toString() ?? null;
    }

    // Mark post as PUBLISHED
    await prisma.generatedPost.update({
      where: { id: post.id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        facebookPostId,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });

    await prisma.jobLog.create({
      data: {
        campaignId: post.campaignId,
        generatedPostId: post.id,
        queueName: 'facebook-publishing-queue',
        jobId: `pub-${post.id}`,
        eventType: 'COMPLETED',
        message: `Đã đăng bài lên Facebook Page ${page.pageName} thành công. Post ID: ${facebookPostId}`,
      },
    });
  } catch (err) {
    let errorMsg = axios.isAxiosError(err)
      ? err.response?.data?.error?.message ?? err.message
      : (err as Error).message;

    const isTokenExpired = errorMsg.includes('expired') || errorMsg.includes('access token') || errorMsg.includes('190') || errorMsg.includes('Session has expired');

    if (isTokenExpired) {
      await prisma.facebookPage.update({
        where: { id: page.id },
        data: { tokenStatus: 'EXPIRED' }
      }).catch(e => logger.error('Lỗi cập nhật tokenStatus EXPIRED:', e));

      errorMsg = `🔑 Access Token của Facebook Page "${page.pageName}" đã HẾT HẠN (Session has expired). Vui lòng chọn tab "Facebook Page" và bấm nút "🔑 Cập nhật Token" để cập nhật Token mới.`;
    } else if (errorMsg.includes('283') || errorMsg.includes('pages_read_engagement')) {
      errorMsg = `Mã Token của Page "${page.pageName}" thiếu quyền 'pages_read_engagement'. Vui lòng tích chọn quyền 'pages_read_engagement' khi lấy Token tại Facebook Graph API Explorer và bấm nút '🔑 Cập nhật Token' để cập nhật!`;
    }

    logger.error(`Lỗi đăng bài FB (Post ID ${post.id}): ${errorMsg}`);

    await prisma.generatedPost.update({
      where: { id: post.id },
      data: {
        status: 'FAILED',
        lastErrorCode: 'PUBLISH_ERROR',
        lastErrorMessage: errorMsg,
      },
    });

    await prisma.jobLog.create({
      data: {
        campaignId: post.campaignId,
        generatedPostId: post.id,
        queueName: 'facebook-publishing-queue',
        jobId: `pub-${post.id}`,
        eventType: 'FAILED',
        message: `Lỗi đăng bài: ${errorMsg}`,
      },
    });

    throw err;
  }
}

export const postSchedulingWorker = new Worker<PostSchedulingJob>(
  'post-scheduling-queue',
  async (job) => {
    logger.info(`Post scheduling job ${job.data.postId}`);
    await facebookPublishingQueue.add(
      'publish',
      { postId: job.data.postId },
      {
        jobId: `pub-${job.data.postId}`,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 60000, // 1 min, 5 min, 15 min exponential backoff
        },
      }
    );
  },
  { connection: redisConnection, concurrency: 2 }
);

export const facebookPublishingWorker = new Worker<PostSchedulingJob>(
  'facebook-publishing-queue',
  async (job) => {
    logger.info(`Publishing post ${job.data.postId}`);
    await publishPost(job.data.postId);
  },
  { connection: redisConnection, concurrency: 2 }
);

facebookPublishingWorker.on('failed', (job, err) => {
  logger.error(`Publishing worker failed (${job?.id})`, err);
});