import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resetAllMockData() {
  console.log('=== RESETTING ALL MOCK DATA FOR REAL PRODUCTION USAGE ===\n');

  // Delete all dependent post and campaign data
  const deletedPostMedias = await prisma.postMedia.deleteMany();
  console.log(`✓ Cleared ${deletedPostMedias.count} post medias`);

  const deletedMediaFiles = await prisma.mediaFile.deleteMany();
  console.log(`✓ Cleared ${deletedMediaFiles.count} media files`);

  const deletedContentRevisions = await prisma.contentRevision.deleteMany();
  console.log(`✓ Cleared ${deletedContentRevisions.count} content revisions`);

  const deletedApprovalHistories = await prisma.approvalHistory.deleteMany();
  console.log(`✓ Cleared ${deletedApprovalHistories.count} approval histories`);

  const deletedPosts = await prisma.generatedPost.deleteMany();
  console.log(`✓ Cleared ${deletedPosts.count} generated posts`);

  const deletedCampaignPages = await prisma.campaignPage.deleteMany();
  console.log(`✓ Cleared ${deletedCampaignPages.count} campaign pages`);

  const deletedCampaigns = await prisma.campaign.deleteMany();
  console.log(`✓ Cleared ${deletedCampaigns.count} campaigns`);

  const deletedUserPages = await prisma.userFacebookPage.deleteMany();
  console.log(`✓ Cleared ${deletedUserPages.count} user facebook page permissions`);

  const deletedPages = await prisma.facebookPage.deleteMany();
  console.log(`✓ Cleared ${deletedPages.count} facebook pages`);

  const deletedJobLogs = await prisma.jobLog.deleteMany();
  console.log(`✓ Cleared ${deletedJobLogs.count} job logs`);

  const deletedAuditLogs = await prisma.auditLog.deleteMany();
  console.log(`✓ Cleared ${deletedAuditLogs.count} audit logs`);

  console.log('\n✅ ALL MOCK & TEST DATA RESET SUCCESSFULLY!');
  console.log('Ready for adding real Facebook Pages and running real production campaigns!');
}

resetAllMockData()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
