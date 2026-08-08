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
    let mediaFiles = await prisma.mediaFile.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { campaignId: campaignId },
          { campaignId: null }
        ]
      },
      orderBy: { createdAt: 'desc' },
    });

    const favIds = campaign.selectedMediaIds || [];

    const allImageFiles = mediaFiles.filter((m) => m.mediaType === 'IMAGE');
    const allVideoFiles = mediaFiles.filter((m) => m.mediaType === 'VIDEO');

    let imageFiles = [...allImageFiles];
    let videoFiles = [...allVideoFiles];

    let selectedDriveFolderTag = '';
    const driveFolderId = favIds.find(id => id.startsWith('GDRIVE_'));
    if (driveFolderId) {
      const folderId = driveFolderId.replace('GDRIVE_', '');
      const setting = await prisma.systemSetting.findUnique({ where: { key: 'gdrive_folder_links' } });
      if (setting?.valueEncrypted) {
        try {
          const folders = JSON.parse(setting.valueEncrypted);
          const matchedFolder = folders.find((f: any) => String(f.id) === folderId);
          if (matchedFolder && matchedFolder.name) {
            selectedDriveFolderTag = matchedFolder.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          }
        } catch (e) {}
      }
    }

    if (selectedDriveFolderTag) {
      const matchedImgs = imageFiles.filter(m => m.fileName.toLowerCase().includes(selectedDriveFolderTag));
      if (matchedImgs.length > 0) imageFiles = matchedImgs;

      const matchedVids = videoFiles.filter(m => m.fileName.toLowerCase().includes(selectedDriveFolderTag));
      if (matchedVids.length > 0) videoFiles = matchedVids;
    } else if (favIds.length > 0) {
      const favImages = imageFiles.filter((m) => favIds.includes(m.id));
      if (favImages.length > 0) imageFiles = favImages;

      const favVideos = videoFiles.filter((m) => favIds.includes(m.id));
      if (favVideos.length > 0) videoFiles = favVideos;
    } else {
      // Smart Brand Matching based on campaign.brandName, campaign.productName, or campaign.originalContent
      const brandText = `${campaign.brandName || ''} ${campaign.productName || ''} ${campaign.originalContent || ''}`.toLowerCase();

      if (brandText.includes('bối bối') || brandText.includes('boiboi') || brandText.includes('bối')) {
        const brandImgs = imageFiles.filter(m => m.fileName.toLowerCase().includes('b_i') || m.fileName.toLowerCase().includes('boiboi'));
        if (brandImgs.length > 0) imageFiles = brandImgs;

        const brandVids = videoFiles.filter(m => m.fileName.toLowerCase().includes('b_i') || m.fileName.toLowerCase().includes('boiboi'));
        if (brandVids.length > 0) videoFiles = brandVids;
      } else if (brandText.includes('kenstore') || brandText.includes('ken store') || brandText.includes('ken')) {
        const brandImgs = imageFiles.filter(m => m.fileName.toLowerCase().includes('ken'));
        if (brandImgs.length > 0) imageFiles = brandImgs;

        const brandVids = videoFiles.filter(m => m.fileName.toLowerCase().includes('ken'));
        if (brandVids.length > 0) videoFiles = brandVids;
      } else if (brandText.includes('mốt lab') || brandText.includes('mot lab') || brandText.includes('motlab') || brandText.includes('mốt')) {
        const brandImgs = imageFiles.filter(m => m.fileName.toLowerCase().includes('m_t') || m.fileName.toLowerCase().includes('motlab'));
        if (brandImgs.length > 0) imageFiles = brandImgs;

        const brandVids = videoFiles.filter(m => m.fileName.toLowerCase().includes('m_t') || m.fileName.toLowerCase().includes('motlab'));
        if (brandVids.length > 0) videoFiles = brandVids;
      } else if (brandText.includes('ụm bò') || brandText.includes('umbo') || brandText.includes('váng sữa')) {
        const brandImgs = imageFiles.filter(m => m.fileName.toLowerCase().includes('u_m') || m.fileName.toLowerCase().includes('umbo'));
        if (brandImgs.length > 0) imageFiles = brandImgs;

        const brandVids = videoFiles.filter(m => m.fileName.toLowerCase().includes('u_m') || m.fileName.toLowerCase().includes('umbo'));
        if (brandVids.length > 0) videoFiles = brandVids;
      }
    }

    const posts = campaign.generatedPosts;

    for (const post of posts) {
      // Clear existing assignments for clean allocation
      await prisma.postMedia.deleteMany({ where: { generatedPostId: post.id } });

      const isVideoMode = campaign.mediaMode === 'VIDEO' || post.mediaType === 'VIDEO';

      if (isVideoMode) {
        // VIDEO MODE: Must pick 1 video file (from filtered videoFiles or fallback to allVideoFiles)
        const availableVideos = videoFiles.length > 0 ? videoFiles : allVideoFiles;
        if (availableVideos.length > 0) {
          const shuffled = this.shuffleArray(availableVideos);
          const selectedVideo = shuffled[0];

          await prisma.postMedia.create({
            data: {
              generatedPostId: post.id,
              mediaFileId: selectedVideo.id,
              sortOrder: 0,
            },
          });
        } else {
          console.warn(`[MediaService Warning] Bài viết ${post.id} ở chế độ VIDEO nhưng Kho Media chưa có tệp Video nào.`);
        }
      } else {
        // IMAGE MODE: Pick 6 photos (from filtered imageFiles or fallback to allImageFiles)
        const availableImages = imageFiles.length > 0 ? imageFiles : allImageFiles;
        if (availableImages.length > 0) {
          let selected: typeof availableImages = [];
          const shuffled = this.shuffleArray(availableImages);

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
}
