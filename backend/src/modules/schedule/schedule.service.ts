import { prisma } from '../../common/database/prisma';
import { postSchedulingQueue } from '../../common/queue/queues';
import { logger } from '../../common/utils/logger';

export interface ScheduleCalculationOptions {
  startAt: Date;
  postCount: number;
  intervalMinutes: number;
  allowedStartTime: string; // e.g. "08:00"
  allowedEndTime: string;   // e.g. "22:00"
  allowedWeekdays: number[]; // 1 = Mon, 7 = Sun
  staggerOffsetMinutes?: number; // Offset for page staggering
}

export class ScheduleService {
  /**
   * Calculates valid post schedule times enforcing allowed hours (08:00-22:00) and weekdays
   */
  public static calculateScheduleTimes(options: ScheduleCalculationOptions): Date[] {
    const {
      startAt,
      postCount,
      intervalMinutes,
      allowedStartTime,
      allowedEndTime,
      allowedWeekdays,
      staggerOffsetMinutes = 0,
    } = options;

    const scheduledDates: Date[] = [];
    let current = new Date(startAt.getTime() + staggerOffsetMinutes * 60 * 1000);

    const [startHour, startMin] = allowedStartTime.split(':').map(Number);
    const [endHour, endMin] = allowedEndTime.split(':').map(Number);

    for (let i = 0; i < postCount; i++) {
      if (i > 0) {
        current = new Date(current.getTime() + intervalMinutes * 60 * 1000);
      }

      // Check and adjust current time to fall within allowed time window and valid weekdays
      current = this.adjustToValidWindow(current, startHour, startMin, endHour, endMin, allowedWeekdays);
      scheduledDates.push(new Date(current));
    }

    return scheduledDates;
  }

  /**
   * Adjusts a date object to fall within [startHour:startMin, endHour:endMin] and allowedWeekdays
   */
  private static adjustToValidWindow(
    date: Date,
    startHour: number,
    startMin: number,
    endHour: number,
    endMin: number,
    allowedWeekdays: number[]
  ): Date {
    let result = new Date(date);

    while (true) {
      // Get JS day (0 = Sun, 1 = Mon ... 6 = Sat). Convert to 1 = Mon ... 7 = Sun
      const jsDay = result.getDay();
      const isoDay = jsDay === 0 ? 7 : jsDay;

      // 1. Check if weekday is allowed
      if (allowedWeekdays.length > 0 && !allowedWeekdays.includes(isoDay)) {
        // Advance to next day at startHour:startMin
        result.setDate(result.getDate() + 1);
        result.setHours(startHour, startMin, 0, 0);
        continue;
      }

      // 2. Check time window
      const hours = result.getHours();
      const minutes = result.getMinutes();

      const currentMinutes = hours * 60 + minutes;
      const windowStart = startHour * 60 + startMin;
      const windowEnd = endHour * 60 + endMin;

      if (currentMinutes < windowStart) {
        // Move forward to windowStart on same day
        result.setHours(startHour, startMin, 0, 0);
        continue;
      }

      if (currentMinutes >= windowEnd) {
        // Move to start window of next day
        result.setDate(result.getDate() + 1);
        result.setHours(startHour, startMin, 0, 0);
        continue;
      }

      // Time is within valid window and weekday!
      break;
    }

    return result;
  }

  /**
   * Enqueues delayed BullMQ jobs for all posts in a campaign
   */
  public static async scheduleCampaignJobs(campaignId: string): Promise<number> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        campaignPages: {
          include: {
            generatedPosts: { where: { status: { in: ['APPROVED', 'SCHEDULED'] } } },
          },
        },
      },
    });

    if (!campaign) throw new Error('Không tìm thấy chiến dịch');

    let totalEnqueued = 0;
    const now = Date.now();

    for (let pIdx = 0; pIdx < campaign.campaignPages.length; pIdx++) {
      const cp = campaign.campaignPages[pIdx];

      // Auto stagger pages by 5 minutes
      const staggerOffset = pIdx * 5;
      const baseStartAt = cp.startAt.getTime() < now ? new Date(now) : cp.startAt;
      const validTimes = this.calculateScheduleTimes({
        startAt: baseStartAt,
        postCount: cp.generatedPosts.length,
        intervalMinutes: cp.intervalMinutes,
        allowedStartTime: cp.allowedStartTime,
        allowedEndTime: cp.allowedEndTime,
        allowedWeekdays: cp.allowedWeekdays,
        staggerOffsetMinutes: staggerOffset,
      });

      for (let i = 0; i < cp.generatedPosts.length; i++) {
        const post = cp.generatedPosts[i];
        const scheduledAt = validTimes[i] || post.scheduledAt;

        // Update post with calculated scheduledAt & SCHEDULED status
        await prisma.generatedPost.update({
          where: { id: post.id },
          data: { scheduledAt, status: 'SCHEDULED' },
        });

        const delay = Math.max(0, scheduledAt.getTime() - now);

        await postSchedulingQueue.add(
          'schedule-post',
          { postId: post.id },
          {
            delay,
            jobId: `sched-${post.id}`,
            removeOnComplete: true,
          }
        );

        totalEnqueued++;
      }
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'SCHEDULED' },
    });

    logger.info(`Đã lên lịch thành công ${totalEnqueued} bài viết cho chiến dịch ${campaignId}`);
    return totalEnqueued;
  }
}
