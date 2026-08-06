import { describe, it, expect } from 'vitest';
import { AiService } from '../modules/ai/ai.service';
import { MediaService } from '../modules/media/media.service';
import { ScheduleService } from '../modules/schedule/schedule.service';

describe('Facebook Automation System Core Unit Tests', () => {
  describe('AiService Validation & Generation', () => {
    it('validates mandatory keywords and missing product names', () => {
      const config = {
        originalContent: 'Nội dung quảng cáo UmBoMilk',
        productName: 'UmBoMilk Premium',
        mandatoryKeywords: ['chính hãng'],
        postCount: 1,
      };

      const resultBad = AiService.validateContent('Nội dung không chứa thông tin', config);
      expect(resultBad.isValid).toBe(false);
      expect(resultBad.errors.length).toBeGreaterThan(0);

      const resultGood = AiService.validateContent('Sản phẩm UmBoMilk Premium chính hãng cao cấp', config);
      expect(resultGood.isValid).toBe(true);
    });

    it('generates posts with mandatory fields intact', async () => {
      const posts = await AiService.generatePosts({
        originalContent: 'Khuyến mãi đặc biệt hôm nay',
        productName: 'Sữa UmBoMilk',
        brandName: 'UmBoMilk',
        productPrice: '450.000đ',
        sku: 'SKU-999',
        postCount: 3,
      });

      expect(posts.length).toBe(3);
      for (const p of posts) {
        expect(p).toContain('UmBoMilk');
        expect(p).toContain('450.000đ');
        expect(p).toContain('SKU-999');
      }
    });
  });

  describe('MediaService Fisher-Yates Allocation', () => {
    it('shuffles array without losing or duplicating elements', () => {
      const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const shuffled = MediaService.shuffleArray(original);
      expect(shuffled.length).toBe(10);
      expect(shuffled.sort((a, b) => a - b)).toEqual(original);
    });
  });

  describe('ScheduleService 08:00-22:00 Window Adjustment', () => {
    it('shifts post scheduled after 22:00 to 08:00 next day', () => {
      // 22:15 on a Monday (2026-08-10 22:15)
      const lateDate = new Date('2026-08-10T22:15:00');

      const validTimes = ScheduleService.calculateScheduleTimes({
        startAt: lateDate,
        postCount: 1,
        intervalMinutes: 15,
        allowedStartTime: '08:00',
        allowedEndTime: '22:00',
        allowedWeekdays: [1, 2, 3, 4, 5, 6, 7],
      });

      expect(validTimes.length).toBe(1);
      const adjusted = validTimes[0];
      // Should be 08:00 next day (2026-08-11 08:00)
      expect(adjusted.getHours()).toBe(8);
      expect(adjusted.getMinutes()).toBe(0);
      expect(adjusted.getDate()).toBe(11);
    });
  });
});
