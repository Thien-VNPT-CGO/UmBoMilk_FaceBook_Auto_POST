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
        mediaFiles: { where: { status: 'ACTIVE' } },
        generatedPosts: true,
      },
    });

    if (!campaign) throw new BadRequestError('Không tìm thấy chiến dịch');

    const imageFiles = campaign.mediaFiles.filter((m) => m.mediaType === 'IMAGE');
    const videoFiles = campaign.mediaFiles.filter((m) => m.mediaType === 'VIDEO');

    const posts = campaign.generatedPosts;

    for (const post of posts) {
      // Clear existing assignments for clean allocation
      await prisma.postMedia.deleteMany({ where: { generatedPostId: post.id } });

      if (post.mediaType === 'IMAGE') {
        if (imageFiles.length < 6 && !campaign.allowMediaReuse) {
          throw new BadRequestError(
            `Không đủ hình ảnh cho bài viết (${imageFiles.length}/6 hình khả dụng, tái sử dụng: tắt). Bài hình cần đúng 6 hình.`
          );
        }

        let selected: typeof imageFiles = [];
        if (imageFiles.length >= 6) {
          // Shuffle and pick 6 unique images for this post
          const shuffled = this.shuffleArray(imageFiles);
          selected = shuffled.slice(0, 6);
        } else {
          // Allow reuse if configured
          const shuffled = this.shuffleArray(imageFiles);
          while (selected.length < 6 && shuffled.length > 0) {
            selected.push(shuffled[selected.length % shuffled.length]);
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
      } else if (post.mediaType === 'VIDEO') {
        if (videoFiles.length === 0) {
          throw new BadRequestError('Không có video nào khả dụng trong chiến dịch');
        }
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
      }
    }
  }
}
