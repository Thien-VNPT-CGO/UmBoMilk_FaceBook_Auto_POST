import { Worker } from 'bullmq';
import axios from 'axios';
import { redisConnection } from '../common/redis/redis';
import { prisma } from '../common/database/prisma';
import { logger } from '../common/utils/logger';
import { decryptString } from '../common/encryption/crypto';
import { facebookPublishingQueue } from '../common/queue/queues';

interface PostSchedulingJob {
  postId: string;
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
  if (!post.postMedias || post.postMedias.length === 0) {
    try {
      const { MediaService } = await import('../modules/media/media.service');
      await MediaService.assignMediaToCampaign(post.campaignId);
      const refetchedPost = await prisma.generatedPost.findUnique({
        where: { id: postId },
        include: {
          postMedias: { include: { mediaFile: true }, orderBy: { sortOrder: 'asc' } },
        },
      });
      if (refetchedPost?.postMedias) {
        post.postMedias = refetchedPost.postMedias;
      }
    } catch (e) {
      logger.warn(`Auto-assigning media before publishing failed: ${(e as Error).message}`);
    }
  }

  const accessToken = decryptString(page.encryptedPageAccessToken);
  const mediaCount = post.postMedias?.length || 0;
  let facebookPostId: string | null = null;

  try {
    if (post.mediaType === 'VIDEO' && mediaCount > 0) {
      // 1. Post Video
      const videoUrl = getPublicMediaUrl(post.postMedias[0].mediaFile.storageUrl);
      const res = await axios.post(
        `https://graph.facebook.com/v19.0/${page.facebookPageId}/videos`,
        null,
        {
          params: {
            access_token: accessToken,
            description: post.content,
            file_url: videoUrl,
          },
          timeout: 60000,
        }
      );
      facebookPostId = res.data?.id?.toString() ?? null;
    } else if (mediaCount > 1) {
      // 2. Post Multi-Photo Album (e.g. 6 Photos)
      try {
        const attachedMediaIds: string[] = [];
        for (const pm of post.postMedias) {
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
              timeout: 20000,
            }
          );
          if (photoRes.data?.id) {
            attachedMediaIds.push(photoRes.data.id);
          }
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
          { params: feedParams, timeout: 20000 }
        );
        facebookPostId = feedRes.data?.id?.toString() ?? null;
      } catch (albumErr: any) {
        logger.warn(`Multi-photo upload failed (${albumErr.message}). Publishing feed post...`);
        const feedRes = await axios.post(
          `https://graph.facebook.com/v19.0/${page.facebookPageId}/feed`,
          null,
          {
            params: { access_token: accessToken, message: post.content },
            timeout: 15000,
          }
        );
        facebookPostId = feedRes.data?.id?.toString() ?? null;
      }
    } else if (mediaCount === 1) {
      // 3. Single Photo Post with fallback
      try {
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
            timeout: 20000,
          }
        );
        facebookPostId = res.data?.id?.toString() ?? null;
      } catch (photoErr: any) {
        logger.warn(`Single photo upload failed (${photoErr.message}). Publishing feed post...`);
        const feedRes = await axios.post(
          `https://graph.facebook.com/v19.0/${page.facebookPageId}/feed`,
          null,
          {
            params: { access_token: accessToken, message: post.content },
            timeout: 15000,
          }
        );
        facebookPostId = feedRes.data?.id?.toString() ?? null;
      }
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