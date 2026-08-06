import axios from 'axios';
import fs from 'fs';
import path from 'path';

const API_URL = 'http://localhost:5000/api';

async function testAiPersistenceAndAdminOnly() {
  console.log('====================================================');
  console.log(' TESTING AI CONFIG PERSISTENCE (.ENV + DB) & ADMIN GUARD');
  console.log('====================================================\n');

  // 1. Login as Admin
  console.log('1. Logging in as System Admin (admin@example.com)...');
  const adminRes = await axios.post(`${API_URL}/auth/login`, {
    email: 'admin@example.com',
    password: 'Admin@123',
  });
  const adminToken = adminRes.data.data.accessToken;
  console.log('  -> Admin Login SUCCESS.');

  // 2. Fetch current AI config as Admin
  console.log('\n2. Fetching GET /api/settings/ai-config as Admin...');
  const cfgRes = await axios.get(`${API_URL}/settings/ai-config`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  console.log('  -> Current AI Config:', cfgRes.data.data);
  console.log('  -> isAdmin:', cfgRes.data.isAdmin);
  if (!cfgRes.data.isAdmin) throw new Error('Expected isAdmin to be true for Admin user!');

  // 3. Save new AI config as Admin
  const testConfig = {
    provider: '9router',
    baseUrl: 'http://localhost:20128/v1',
    apiKey: 'sk-53efd6fb0fc112f3-bmzho9-0dcd7de6',
    model: 'COMBO_API_ALL',
  };

  console.log('\n3. Saving new 9router AI config via POST /api/settings as Admin...', testConfig);
  const saveRes = await axios.post(
    `${API_URL}/settings`,
    {
      key: 'ai_config',
      valueJson: testConfig,
    },
    {
      headers: { Authorization: `Bearer ${adminToken}` },
    }
  );
  console.log('  -> Save Response:', saveRes.data.message);

  // 4. Verify disk file .env was updated
  console.log('\n4. Verifying disk file backend/.env contains saved AI parameters...');
  const envPath = path.resolve(__dirname, '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  console.log('  -> Reading backend/.env:');
  const matches = envContent.split('\n').filter(line => line.startsWith('AI_'));
  console.log(matches.join('\n'));

  if (!envContent.includes('AI_API_BASE_URL="http://localhost:20128/v1"')) {
    throw new Error('.env file missing saved AI_API_BASE_URL!');
  }
  if (!envContent.includes('AI_MODEL="COMBO_API_ALL"')) {
    throw new Error('.env file missing saved AI_MODEL!');
  }
  console.log('  -> PERSISTENCE TO .ENV FILE VERIFIED SUCCESS!');

  // 5. Test Non-Admin User (Manager / Editor) attempts to save AI config
  console.log('\n5. Creating non-admin Editor user and attempting to modify AI config...');
  const createEditorRes = await axios.post(
    `${API_URL}/users`,
    {
      name: 'NonAdmin Editor',
      email: 'editor_test@example.com',
      username: 'editor_test',
      password: 'User@123',
    },
    {
      headers: { Authorization: `Bearer ${adminToken}` },
    }
  );

  const editorLoginRes = await axios.post(`${API_URL}/auth/login`, {
    email: 'editor_test@example.com',
    password: 'User@123',
  });
  const editorToken = editorLoginRes.data.data.accessToken;

  console.log('  -> Attempting POST /api/settings as Editor user...');
  try {
    await axios.post(
      `${API_URL}/settings`,
      {
        key: 'ai_config',
        valueJson: { baseUrl: 'http://hacker.com/v1' },
      },
      {
        headers: { Authorization: `Bearer ${editorToken}` },
      }
    );
    throw new Error('Non-Admin user WAS ALLOWED to update AI config! Security failed!');
  } catch (err: any) {
    if (err.response?.status === 403) {
      console.log('  -> SECURITY VERIFIED SUCCESS: Editor user received HTTP 403 Forbidden!');
      console.log('     ErrorMessage:', err.response.data.error?.message || err.response.data.message);
    } else {
      throw err;
    }
  }

  // Cleanup editor user
  await axios.delete(`${API_URL}/users/${createEditorRes.data.data.id}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  console.log('\n====================================================');
  console.log(' ALL PERSISTENCE AND ADMIN-ONLY TESTS PASSED 100%! ');
  console.log('====================================================');
}

testAiPersistenceAndAdminOnly().catch(err => {
  console.error('Test Failed:', err.response?.data || err.message);
  process.exit(1);
});
