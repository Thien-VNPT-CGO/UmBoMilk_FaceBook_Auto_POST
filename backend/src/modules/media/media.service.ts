import { prisma } from '../../common/database/prisma';
import { BadRequestError } from '../../common/utils/errors';

export class MediaService {
  /**
   * Fisher-Yates Shuffle algorithm for unbiased random array shuffling
   */
  public static shuffleArray<T>(array: T[]): T[] {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * Assigns media (6 photos per image post, 1 video per video post) to generated posts of a campaign
   */
  public static async assignMediaToCampaign(campaignId: string): Promise<void> {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        generatedPosts: true,
      },
    });

    if (!campaign) throw new BadRequestError('Không tìm thấy chiến dịch');

    // Get active media files: both campaign-specific AND global active media (from Kho Media)
    const mediaFiles = await prisma.mediaFile.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { campaignId: campaignId },
          { campaignId: null }
        ]
      },
      orderBy: { createdAt: 'desc' },
    });

    const imageFiles = mediaFiles.filter((m) => m.mediaType === 'IMAGE');
    const videoFiles = mediaFiles.filter((m) => m.mediaType === 'VIDEO');

    const posts = campaign.generatedPosts;

    for (const post of posts) {
      // Clear existing assignments for clean allocation
      await prisma.postMedia.deleteMany({ where: { generatedPostId: post.id } });

      const hasImages = imageFiles.length > 0;
      const hasVideos = videoFiles.length > 0;

      if (!hasImages && !hasVideos) {
        console.warn(`[MediaService] Không có media (ảnh/video) nào trong Kho Media cho bài viết ${post.id}`);
        continue;
      }

      const shouldAssignVideo = (post.mediaType === 'VIDEO' && hasVideos) || (!hasImages && hasVideos);

      if (shouldAssignVideo) {
        // Pick 1 video
        const shuffled = this.shuffleArray(videoFiles);
        const selectedVideo = shuffled[0];

        await prisma.postMedia.create({
          data: {
            generatedPostId: post.id,
            mediaFileId: selectedVideo.id,
            sortOrder: 0,
          },
        });
      } else {
        // Pick 6 photos (or available photos with wrap-around reuse)
        let selected: typeof imageFiles = [];
        const shuffled = this.shuffleArray(imageFiles);

        if (shuffled.length >= 6) {
          selected = shuffled.slice(0, 6);
        } else {
          for (let i = 0; i < 6; i++) {
            selected.push(shuffled[i % shuffled.length]);
          }
        }

        // Save PostMedia relations
        for (let i = 0; i < selected.length; i++) {
          await prisma.postMedia.create({
            data: {
              generatedPostId: post.id,
              mediaFileId: selected[i].id,
              sortOrder: i,
            },
          });
        }
      }
    }
  }
}
