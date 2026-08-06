import { Worker } from 'bullmq';
import { redisConnection } from '../common/redis/redis';
import { prisma } from '../common/database/prisma';
import { logger } from '../common/utils/logger';
import { AiService } from '../modules/ai/ai.service';
import { ScheduleService } from '../modules/schedule/schedule.service';

interface ContentGenerationJob {
  campaignId: string;
}

async function processContentGeneration(job: { data: ContentGenerationJob; id?: string }) {
  const { campaignId } = job.data;
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { campaignPages: { include: { facebookPage: true } } },
  });
  if (!campaign) throw new Error(`Campaign ${campaignId} không tồn tại`);

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'GENERATING' } });

  const isShared = campaign.contentMode === 'SHARED';
  let createdCount = 0;

  if (isShared) {
    // SHARED mode: Generate one set of posts (size = campaign.defaultPostCount)
    const aiTexts = await AiService.generatePosts({
      originalContent: campaign.originalContent,
      productName: campaign.productName,
      brandName: campaign.brandName,
      productPrice: campaign.productPrice,
      discountPrice: campaign.discountPrice,
      sku: campaign.sku,
      mandatoryKeywords: campaign.mandatoryKeywords,
      bannedKeywords: campaign.bannedKeywords,
      tone: campaign.tone,
      lengthConfig: campaign.lengthConfig,
      allowEmoji: campaign.allowEmoji,
      allowHashtag: campaign.allowHashtag,
      ctaRequired: campaign.ctaRequired,
      postCount: campaign.defaultPostCount,
    });

    for (let cpIdx = 0; cpIdx < campaign.campaignPages.length; cpIdx++) {
      const cp = campaign.campaignPages[cpIdx];
      const validTimes = ScheduleService.calculateScheduleTimes({
        startAt: cp.startAt,
        postCount: cp.postCount,
        intervalMinutes: cp.intervalMinutes,
        allowedStartTime: cp.allowedStartTime,
        allowedEndTime: cp.allowedEndTime,
        allowedWeekdays: cp.allowedWeekdays,
        staggerOffsetMinutes: cpIdx * 5,
      });

      for (let i = 0; i < cp.postCount; i++) {
        const text = aiTexts[i % aiTexts.length];
        const scheduledAt = validTimes[i] || new Date(cp.startAt.getTime() + i * cp.intervalMinutes * 60000);

        await prisma.generatedPost.create({
          data: {
            campaignId,
            campaignPageId: cp.id,
            content: text,
            mediaType: campaign.mediaMode === 'VIDEO' ? 'VIDEO' : 'IMAGE',
            scheduledAt,
            status: 'PENDING_APPROVAL',
            sequenceNumber: i + 1,
            idempotencyKey: `${campaign.id}:${cp.id}:${i}:${Date.now()}`,
          },
        });
        createdCount++;
      }
    }
  } else {
    // INDIVIDUAL mode: Generate a separate AI batch for each page
    for (let cpIdx = 0; cpIdx < campaign.campaignPages.length; cpIdx++) {
      const cp = campaign.campaignPages[cpIdx];
      const aiTexts = await AiService.generatePosts({
        originalContent: campaign.originalContent,
        productName: campaign.productName,
        brandName: campaign.brandName,
        productPrice: campaign.productPrice,
        discountPrice: campaign.discountPrice,
        sku: campaign.sku,
        mandatoryKeywords: campaign.mandatoryKeywords,
        bannedKeywords: campaign.bannedKeywords,
        tone: campaign.tone,
        lengthConfig: campaign.lengthConfig,
        allowEmoji: campaign.allowEmoji,
        allowHashtag: campaign.allowHashtag,
        ctaRequired: campaign.ctaRequired,
        postCount: cp.postCount,
      });

      const validTimes = ScheduleService.calculateScheduleTimes({
        startAt: cp.startAt,
        postCount: cp.postCount,
        intervalMinutes: cp.intervalMinutes,
        allowedStartTime: cp.allowedStartTime,
        allowedEndTime: cp.allowedEndTime,
        allowedWeekdays: cp.allowedWeekdays,
        staggerOffsetMinutes: cpIdx * 5,
      });

      for (let i = 0; i < cp.postCount; i++) {
        const text = aiTexts[i];
        const scheduledAt = validTimes[i] || new Date(cp.startAt.getTime() + i * cp.intervalMinutes * 60000);

        await prisma.generatedPost.create({
          data: {
            campaignId,
            campaignPageId: cp.id,
            content: text,
            mediaType: campaign.mediaMode === 'VIDEO' ? 'VIDEO' : 'IMAGE',
            scheduledAt,
            status: 'PENDING_APPROVAL',
            sequenceNumber: i + 1,
            idempotencyKey: `${campaign.id}:${cp.id}:${i}:${Date.now()}`,
          },
        });
        createdCount++;
      }
    }
  }

  // Automatically assign media (6 photos / 1 video per post) from Kho Media
  try {
    const { MediaService } = await import('../modules/media/media.service');
    await MediaService.assignMediaToCampaign(campaignId);
  } catch (mediaErr) {
    logger.warn(`[ContentGenWorker] Auto-assign media error: ${(mediaErr as Error).message}`);
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'PENDING_APPROVAL' } });
  await prisma.jobLog.create({
    data: {
      campaignId,
      queueName: 'content-generation-queue',
      jobId: job.id ?? 'unknown',
      eventType: 'COMPLETED',
      message: `Đã tạo ${createdCount} bài viết AI và tự động gán media từ Kho Media thành công!`,
    },
  });
}

export const contentGenerationWorker = new Worker<ContentGenerationJob>(
  'content-generation-queue',
  async (job) => {
    logger.info(`Content generation job ${job.id}`);
    await processContentGeneration({ data: job.data, id: job.id });
  },
  { connection: redisConnection, concurrency: 4 }
);

contentGenerationWorker.on('failed', (job, err) => {
  logger.error(`Content generation failed (${job?.id})`, err);
  if (job?.data.campaignId) {
    void prisma.jobLog.create({
      data: {
        campaignId: job.data.campaignId,
        queueName: 'content-generation-queue',
        jobId: job.id ?? 'unknown',
        eventType: 'FAILED',
        message: err.message,
      },
    });
  }
});