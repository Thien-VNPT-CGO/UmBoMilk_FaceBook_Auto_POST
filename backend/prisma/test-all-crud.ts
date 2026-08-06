import axios from 'axios';

const API_BASE = 'http://localhost:5000/api';

async function testAllCRUD() {
  console.log('====================================================');
  console.log('  TESTING ALL SYSTEM CREATION, EDIT, DELETE (CRUD)');
  console.log('====================================================\n');

  // 1. Login as Admin
  console.log('1. [AUTH] Logging in as Admin...');
  const loginRes = await axios.post(`${API_BASE}/auth/login`, {
    email: 'admin@example.com',
    password: 'Admin@123',
  });
  const token = loginRes.data.data.accessToken;
  const authHeader = { headers: { Authorization: `Bearer ${token}` } };
  console.log('  -> Login SUCCESS. Token acquired.');

  // 2. USER CRUD
  console.log('\n2. [USER CRUD] Testing Create, Read, Update, Delete User...');
  
  // 2a. Create User
  const testUserUsername = `crud_user_${Date.now()}`;
  const testUserEmail = `${testUserUsername}@example.com`;
  const createUserRes = await axios.post(
    `${API_BASE}/users`,
    {
      name: 'Test CRUD User',
      email: testUserEmail,
      username: testUserUsername,
      password: 'UserPass@123',
    },
    authHeader
  );
  const userId = createUserRes.data.data.id || createUserRes.data.data;
  console.log(`  -> CREATE User SUCCESS. ID: ${userId}`);

  // 2b. Get Roles
  const rolesRes = await axios.get(`${API_BASE}/roles`, authHeader);
  const managerRole = rolesRes.data.data.find((r: any) => r.name === 'MANAGER' || r.name === 'Manager');
  const roleId = managerRole?.id;

  // 2c. Update User
  await axios.put(
    `${API_BASE}/users/${userId}`,
    {
      name: 'Test CRUD User Updated',
      phone: '0987654321',
      roleIds: roleId ? [roleId] : [],
    },
    authHeader
  );
  console.log('  -> UPDATE User SUCCESS.');

  // 2d. Get User Details
  const getUserRes = await axios.get(`${API_BASE}/users/${userId}`, authHeader);
  console.log(`  -> READ User SUCCESS. Updated Name: ${getUserRes.data.data.name}`);

  // 2e. Delete User
  await axios.delete(`${API_BASE}/users/${userId}`, authHeader);
  console.log('  -> DELETE User SUCCESS.');

  // 3. FACEBOOK PAGE CRUD
  console.log('\n3. [PAGE CRUD] Testing Create, Read, Delete Facebook Page...');
  
  // 3a. Create Page
  const testPageId = `FB_TEST_${Date.now()}`;
  const createPageRes = await axios.post(
    `${API_BASE}/facebook-pages`,
    {
      pageName: 'UmBoMilk Test Page',
      facebookPageId: testPageId,
      pageAccessToken: `EAA_TEST_TOKEN_${Date.now()}`,
      defaultPostCount: 5,
      defaultIntervalMinutes: 20,
    },
    authHeader
  );
  const pageDbId = createPageRes.data.data.id;
  console.log(`  -> CREATE Page SUCCESS. ID: ${pageDbId}`);

  // 3b. Read Page
  const getPageRes = await axios.get(`${API_BASE}/facebook-pages/${pageDbId}`, authHeader);
  console.log(`  -> READ Page SUCCESS. Page Name: ${getPageRes.data.data.pageName}`);

  // 3c. Delete Page
  await axios.delete(`${API_BASE}/facebook-pages/${pageDbId}`, authHeader);
  console.log('  -> DELETE Page SUCCESS.');

  // 4. CAMPAIGN CRUD
  console.log('\n4. [CAMPAIGN CRUD] Testing Create, Read, Update, Delete Campaign...');
  
  // Create temporary page for campaign
  const campaignPageRes = await axios.post(
    `${API_BASE}/facebook-pages`,
    {
      pageName: 'Campaign Target Page',
      facebookPageId: `FB_CAMP_${Date.now()}`,
      pageAccessToken: `EAA_CAMP_TOKEN_${Date.now()}`,
    },
    authHeader
  );
  const campPageDbId = campaignPageRes.data.data.id;

  // 4a. Create Campaign
  const createCampRes = await axios.post(
    `${API_BASE}/campaigns`,
    {
      name: 'Test Automation Campaign',
      description: 'Test Campaign Description',
      originalContent: 'Khuyến mãi sữa UmBoMilk cao cấp giảm giá 20% hôm nay',
      facebookPageIds: [campPageDbId],
      startDate: new Date().toISOString(),
      defaultPostCount: 3,
      defaultIntervalMinutes: 15,
      productName: 'UmBoMilk Gold',
      brandName: 'UmBoMilk',
    },
    authHeader
  );
  const campaignId = createCampRes.data.data.id;
  console.log(`  -> CREATE Campaign SUCCESS. ID: ${campaignId}`);

  // 4b. Read Campaign
  const getCampRes = await axios.get(`${API_BASE}/campaigns/${campaignId}`, authHeader);
  console.log(`  -> READ Campaign SUCCESS. Campaign Name: ${getCampRes.data.data.name}`);

  // 4c. Update Campaign
  await axios.put(
    `${API_BASE}/campaigns/${campaignId}`,
    {
      name: 'Test Automation Campaign UPDATED',
      productName: 'UmBoMilk Platinum',
    },
    authHeader
  );
  console.log('  -> UPDATE Campaign SUCCESS.');

  // 4d. Delete Campaign
  await axios.delete(`${API_BASE}/campaigns/${campaignId}`, authHeader);
  console.log('  -> DELETE Campaign SUCCESS.');

  // Clean up test page
  await axios.delete(`${API_BASE}/facebook-pages/${campPageDbId}`, authHeader);

  console.log('\n====================================================');
  console.log('  ALL CRUD TESTS (CREATE, READ, UPDATE, DELETE) PASSED 100%!');
  console.log('====================================================');
}

testAllCRUD().catch((err) => {
  console.error('\n❌ CRUD TEST ERROR:', err.response?.data || err.message);
  process.exit(1);
});
