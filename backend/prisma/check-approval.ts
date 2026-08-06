import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function checkApprovalState() {
  const campaigns = await prisma.campaign.findMany({
    include: { generatedPosts: true, campaignPages: true },
  });
  console.log(`Total campaigns: ${campaigns.length}`);
  for (const c of campaigns) {
    console.log(`Campaign: "${c.name}" (ID: ${c.id}) - Status: ${c.status} - Posts count: ${c.generatedPosts.length}`);
    for (const p of c.generatedPosts) {
      console.log(`  Post: "${p.content.substring(0, 30)}..." | Status: ${p.status}`);
    }
  }

  const allPosts = await prisma.generatedPost.findMany({
    include: { campaign: true, campaignPage: { include: { facebookPage: true } } },
  });
  console.log(`\nTotal GeneratedPosts in DB: ${allPosts.length}`);
}

checkApprovalState().finally(() => prisma.$disconnect());
