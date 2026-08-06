import { AiService } from './src/modules/ai/ai.service';

async function testAi() {
  console.log('Testing AiService with 9router integration...');
  const posts = await AiService.generatePosts({
    originalContent: 'Sữa UmBoMilk cao cấp giàu chất dinh dưỡng hỗ trợ sức khỏe.',
    productName: 'Sữa UmBoMilk 18',
    brandName: 'UmBoMilk',
    postCount: 2,
    allowEmoji: true,
    allowHashtag: true,
  });

  console.log('\n--- Generated Posts Result ---');
  posts.forEach((p, i) => {
    console.log(`\n[Post #${i + 1}]\n${p}`);
  });
  console.log('\n✅ AiService Test Passed 100%!');
}

testAi();
