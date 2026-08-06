import { Router } from 'express';
import { requireAuth } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError } from '../../common/utils/errors';
import { ScheduleService } from './schedule.service';

const router = Router();

// 1. Get schedule preview for campaign (per page timeline)
router.get('/campaigns/:campaignId/schedule', requireAuth, requirePermission('schedule.view'), async (req, res, next) => {
  try {
    const campaignPages = await prisma.campaignPage.findMany({
      where: { campaignId: req.params.campaignId },
      include: {
        facebookPage: true,
        generatedPosts: {
          orderBy: { sequenceNumber: 'asc' },
          include: { postMedias: { include: { mediaFile: true } } },
        },
      },
    });

    res.json({ data: campaignPages });
  } catch (err) {
    next(err);
  }
});

// 2. Generate and trigger BullMQ delayed jobs for campaign schedule
router.post(
  '/campaigns/:campaignId/schedule/generate',
  requireAuth,
  requirePermission('schedule.create'),
  async (req, res, next) => {
    try {
      const count = await ScheduleService.scheduleCampaignJobs(req.params.campaignId);
      res.json({ message: `Đã kích hoạt lên lịch cho ${count} bài viết thành công`, count });
    } catch (err) {
      next(err);
    }
  }
);

// 3. Shift schedule for a specific page or campaign
router.post(
  '/campaigns/:campaignId/schedule/shift',
  requireAuth,
  requirePermission('schedule.update'),
  async (req, res, next) => {
    try {
      const { minutesShift, facebookPageId } = req.body;
      if (typeof minutesShift !== 'number') throw new BadRequestError('minutesShift phải là số phút');

      const whereCondition = facebookPageId
        ? { campaignId: req.params.campaignId, campaignPage: { facebookPageId } }
        : { campaignId: req.params.campaignId };

      const posts = await prisma.generatedPost.findMany({ where: whereCondition });

      for (const post of posts) {
        const newTime = new Date(post.scheduledAt.getTime() + minutesShift * 60 * 1000);
        await prisma.generatedPost.update({
          where: { id: post.id },
          data: { scheduledAt: newTime },
        });
      }

      res.json({ message: `Đã dịch chuyển thời gian ${posts.length} bài viết thêm ${minutesShift} phút` });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
