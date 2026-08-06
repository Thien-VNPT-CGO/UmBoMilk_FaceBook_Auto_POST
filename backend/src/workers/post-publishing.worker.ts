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

async function publishPost(postId: string) {
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

  const accessToken = decryptString(page.encryptedPageAccessToken);
  const mediaCount = post.postMedias?.length || 0;

  try {
    let facebookPostId: string | null = null;

    if (post.mediaType === 'VIDEO' && mediaCount > 0) {
      // 1. Post Video
      const videoUrl = post.postMedias[0].mediaFile.storageUrl;
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
      const attachedMediaIds: string[] = [];

      // Step A: Upload photos unpublished to get photo IDs
      for (const pm of post.postMedias) {
        const photoRes = await axios.post(
          `https://graph.facebook.com/v19.0/${page.facebookPageId}/photos`,
          null,
          {
            params: {
              access_token: accessToken,
              url: pm.mediaFile.storageUrl,
              published: false,
            },
            timeout: 20000,
          }
        );
        if (photoRes.data?.id) {
          attachedMediaIds.push(photoRes.data.id);
        }
      }

      // Step B: Create Feed post containing attached media IDs
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
    } else if (mediaCount === 1) {
      // 3. Post Single Photo
      const photoUrl = post.postMedias[0].mediaFile.storageUrl;
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
    const errorMsg = axios.isAxiosError(err)
      ? err.response?.data?.error?.message ?? err.message
      : (err as Error).message;

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