import { PrismaClient } from '@prisma/client';
import { v4 as uuid } from 'uuid';

const prisma = new PrismaClient();

async function seedApprovalPosts() {
  console.log('=== Populating Posts for Approval Queue ===');

  const campaigns = await prisma.campaign.findMany({
    include: { campaignPages: { include: { facebookPage: true } }, generatedPosts: true },
  });

  console.log(`Found ${campaigns.length} campaigns`);

  for (const c of campaigns) {
    if (c.generatedPosts.length === 0) {
      console.log(`Generating posts for campaign "${c.name}" (${c.id})...`);
      
      let pages = c.campaignPages;
      if (pages.length === 0) {
        // If no campaignPages, link to first available Facebook Page or create a dummy page
        let page = await prisma.facebookPage.findFirst();
        if (!page) {
          const adminUser = await prisma.user.findFirst();
          page = await prisma.facebookPage.create({
            data: {
              ownerId: adminUser!.id,
              pageName: 'UmBoMilk Official Page',
              facebookPageId: `FB_PAGE_${Date.now()}`,
              encryptedPageAccessToken: 'EAA_DUMMY_TOKEN',
            },
          });
        }
        const cp = await prisma.campaignPage.create({
          data: {
            campaignId: c.id,
            facebookPageId: page.id,
            postCount: c.defaultPostCount || 5,
            intervalMinutes: c.defaultIntervalMinutes || 15,
            startAt: c.startDate || new Date(),
          },
        });
        pages = [cp as any];
      }

      for (const cp of pages) {
        for (let i = 0; i < (cp.postCount || 5); i++) {
          const scheduledAt = new Date(Date.now() + (i + 1) * 15 * 60000);
          const postText = `[Bài mẫu ${i + 1}/${cp.postCount || 5}] ${c.originalContent || 'Khuyến mãi sữa UmBoMilk cao cấp hỗ trợ sức khỏe toàn diện.'}`;
          await prisma.generatedPost.create({
            data: {
              campaignId: c.id,
              campaignPageId: cp.id,
              content: postText,
              mediaType: c.mediaMode === 'VIDEO' ? 'VIDEO' : 'IMAGE',
              scheduledAt,
              status: 'PENDING_APPROVAL',
              sequenceNumber: i + 1,
              idempotencyKey: `post:${c.id}:${cp.facebookPageId}:${i + 1}:${uuid()}`,
            },
          });
        }
      }
      
      await prisma.campaign.update({
        where: { id: c.id },
        data: { status: 'PENDING_APPROVAL' },
      });
      console.log(`  -> Seeded posts for campaign "${c.name}" successfully!`);
    } else {
      console.log(`Campaign "${c.name}" already has ${c.generatedPosts.length} posts.`);
    }
  }

  const pendingCount = await prisma.generatedPost.count({
    where: { status: 'PENDING_APPROVAL' },
  });
  console.log(`\n✅ Total PENDING_APPROVAL posts now in DB: ${pendingCount}`);
}

seedApprovalPosts()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
