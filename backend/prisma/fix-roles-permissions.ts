import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ALL_PERMISSIONS = [
  // User management
  ['user.view', 'Xem danh sách người dùng', 'USERS'],
  ['user.create', 'Tạo mới người dùng', 'USERS'],
  ['user.update', 'Cập nhật người dùng', 'USERS'],
  ['user.delete', 'Xóa người dùng', 'USERS'],
  ['user.lock', 'Khóa/mở khóa tài khoản', 'USERS'],
  ['user.reset_password', 'Đặt lại mật khẩu người dùng', 'USERS'],

  // Role management
  ['role.view', 'Xem vai trò', 'ROLES'],
  ['role.create', 'Tạo vai trò mới', 'ROLES'],
  ['role.update', 'Cập nhật vai trò', 'ROLES'],
  ['role.delete', 'Xóa vai trò', 'ROLES'],
  ['role.assign', 'Gán vai trò cho người dùng', 'ROLES'],
  ['role.manage', 'Quản lý vai trò & quyền', 'ROLES'],
  ['roles.view', 'Xem vai trò (alias)', 'ROLES'],
  ['roles.manage', 'Quản lý vai trò (alias)', 'ROLES'],

  // Page management
  ['page.view', 'Xem danh sách Facebook Page', 'PAGES'],
  ['page.create', 'Thêm mới Facebook Page', 'PAGES'],
  ['page.update', 'Cập nhật thông tin Page', 'PAGES'],
  ['page.delete', 'Xóa Facebook Page', 'PAGES'],
  ['page.check_token', 'Kiểm tra trạng thái Access Token', 'PAGES'],
  ['page.manage_token', 'Quản lý mã hóa Access Token', 'PAGES'],
  ['page.test_post', 'Đăng bài kiểm tra Token', 'PAGES'],

  // Campaign management
  ['campaign.view', 'Xem chiến dịch', 'CAMPAIGNS'],
  ['campaign.create', 'Tạo chiến dịch mới', 'CAMPAIGNS'],
  ['campaign.update', 'Cập nhật chiến dịch', 'CAMPAIGNS'],
  ['campaign.delete', 'Xóa chiến dịch', 'CAMPAIGNS'],
  ['campaign.activate', 'Kích hoạt chiến dịch', 'CAMPAIGNS'],
  ['campaign.pause', 'Tạm dừng chiến dịch', 'CAMPAIGNS'],
  ['campaign.resume', 'Tiếp tục chiến dịch', 'CAMPAIGNS'],
  ['campaign.cancel', 'Hủy chiến dịch', 'CAMPAIGNS'],
  ['campaigns.view', 'Xem chiến dịch (alias)', 'CAMPAIGNS'],

  // Content management
  ['content.view_original', 'Xem nội dung gốc', 'CONTENT'],
  ['content.view_ai', 'Xem nội dung AI tạo', 'CONTENT'],
  ['content.edit', 'Chỉnh sửa nội dung bài viết', 'CONTENT'],
  ['content.generate', 'Tạo nội dung tự động bằng AI', 'CONTENT'],
  ['content.regenerate', 'Tạo lại nội dung bằng AI', 'CONTENT'],
  ['content.approve', 'Duyệt bài viết', 'CONTENT'],
  ['content.reject', 'Từ chối bài viết', 'CONTENT'],

  // Media management
  ['media.view', 'Xem kho hình ảnh/video', 'MEDIA'],
  ['media.upload', 'Tải lên media', 'MEDIA'],
  ['media.replace', 'Thay thế media', 'MEDIA'],
  ['media.delete', 'Xóa media', 'MEDIA'],
  ['media.assign', 'Phân bổ media cho bài viết', 'MEDIA'],

  // Schedule management
  ['schedule.view', 'Xem lịch đăng bài', 'SCHEDULE'],
  ['schedule.create', 'Tạo lịch đăng bài', 'SCHEDULE'],
  ['schedule.update', 'Chỉnh sửa lịch đăng', 'SCHEDULE'],
  ['schedule.publish_now', 'Đăng bài ngay', 'SCHEDULE'],

  // Post management
  ['post.view', 'Xem bài viết', 'POSTS'],
  ['post.publish', 'Đăng bài viết', 'POSTS'],
  ['post.retry', 'Thử lại bài viết lỗi', 'POSTS'],
  ['post.cancel', 'Hủy bài viết', 'POSTS'],

  // Reports & Logs
  ['report.view', 'Xem báo cáo', 'REPORTS'],
  ['report.export', 'Xuất báo cáo CSV/Excel', 'REPORTS'],
  ['reports.view', 'Xem báo cáo (alias)', 'REPORTS'],
  ['log.view', 'Xem nhật ký hệ thống', 'LOGS'],
  ['audit.view', 'Xem Audit Log', 'LOGS'],

  // Settings
  ['setting.view', 'Xem cài đặt hệ thống', 'SETTINGS'],
  ['setting.update', 'Cập nhật cài đặt', 'SETTINGS'],
  ['branding.update', 'Cập nhật nhận diện thương hiệu', 'SETTINGS'],
  ['ai_setting.update', 'Cập nhật cấu hình AI', 'SETTINGS'],

  // Users alias
  ['users.view', 'Xem người dùng (alias)', 'USERS'],
  ['users.create', 'Tạo người dùng (alias)', 'USERS'],
];

const MANAGER_PERMISSIONS = [
  // Page viewing & token check ONLY (Strictly NO page.create / page.delete / page.manage)
  'page.view', 'pages.view', 'page.check_token',
  
  // Campaign management & approval
  'campaign.view', 'campaigns.view', 'campaign.create', 'campaign.update', 'campaign.activate', 'campaign.pause', 'campaign.resume',
  
  // Content approval & rejection (Primary function for Manager)
  'content.view_original', 'content.view_ai', 'content.edit', 'content.generate', 'content.regenerate', 'content.approve', 'content.reject',
  'campaign.approve', 'campaigns.approve',
  
  // Media viewing & assign
  'media.view', 'media.upload', 'media.assign',
  
  // Schedule & post management
  'schedule.view', 'schedule.create', 'schedule.update', 'schedule.publish_now',
  'post.view', 'post.publish', 'post.retry',
  
  // Reports & Logs viewing
  'report.view', 'report.export', 'reports.view', 'log.view',
  
  // User viewing ONLY (Strictly NO user.delete / user.create / user.update / user.lock)
  'user.view', 'users.view',
];

const EDITOR_PERMISSIONS = [
  'page.view', 'pages.view',
  'campaign.view', 'campaign.create', 'campaigns.view',
  'content.view_original', 'content.view_ai', 'content.edit', 'content.generate', 'content.regenerate',
  'media.view', 'media.upload',
  'schedule.view',
  'post.view',
  'report.view', 'reports.view',
];

const VIEWER_PERMISSIONS = [
  'page.view', 'pages.view',
  'campaign.view', 'campaigns.view',
  'content.view_original', 'content.view_ai',
  'media.view',
  'schedule.view',
  'post.view',
  'report.view', 'reports.view',
];

async function main() {
  console.log('=== Fixing Permissions & Roles ===\n');

  // Seed/upsert all permissions
  const seededPerms = await Promise.all(
    ALL_PERMISSIONS.map(([code, name, module]) =>
      prisma.permission.upsert({
        where: { code },
        update: { name, module },
        create: { code, name, module },
      })
    )
  );
  console.log(`✓ Seeded ${seededPerms.length} permissions`);

  const permMap = Object.fromEntries(seededPerms.map(p => [p.code, p.id]));

  // Ensure system roles exist
  const adminRole = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: { description: 'Quản trị viên tối cao: Toàn quyền hệ thống, phê duyệt bài viết, tạo/xóa người dùng & Page', isSystemRole: true },
    create: { name: 'Admin', description: 'Quản trị viên tối cao: Toàn quyền hệ thống, phê duyệt bài viết, tạo/xóa người dùng & Page', isSystemRole: true },
  });

  const managerRole = await prisma.role.upsert({
    where: { name: 'MANAGER' },
    update: { description: 'Quản lý chiến dịch: Duyệt & từ chối bài viết AI (Không được xóa người dùng, không được tạo Page)', isSystemRole: true },
    create: { name: 'MANAGER', description: 'Quản lý chiến dịch: Duyệt & từ chối bài viết AI (Không được xóa người dùng, không được tạo Page)', isSystemRole: true },
  });

  const editorRole = await prisma.role.upsert({
    where: { name: 'EDITOR' },
    update: { description: 'Biên tập viên: Tạo chiến dịch & bài viết AI (Tất cả bài viết tự động chờ Admin/Manager duyệt)', isSystemRole: true },
    create: { name: 'EDITOR', description: 'Biên tập viên: Tạo chiến dịch & bài viết AI (Tất cả bài viết tự động chờ Admin/Manager duyệt)', isSystemRole: true },
  });

  const viewerRole = await prisma.role.upsert({
    where: { name: 'VIEWER' },
    update: { description: 'Xem thông tin tổng quan, báo cáo (Không được duyệt hay chỉnh sửa)', isSystemRole: true },
    create: { name: 'VIEWER', description: 'Xem thông tin tổng quan, báo cáo (Không được duyệt hay chỉnh sửa)', isSystemRole: true },
  });

  // Also keep legacy roles from original seed
  await prisma.role.upsert({
    where: { name: 'ADMIN' },
    update: { description: 'Quản trị viên tối cao (alias Admin)', isSystemRole: true },
    create: { name: 'ADMIN', description: 'Quản trị viên tối cao (alias Admin)', isSystemRole: true },
  });

  console.log('✓ System roles created/updated');

  // Assign ALL permissions to Admin role
  await prisma.rolePermission.deleteMany({ where: { roleId: adminRole.id } });
  await prisma.rolePermission.createMany({
    data: seededPerms.map(p => ({ roleId: adminRole.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  console.log(`✓ Admin role: all ${seededPerms.length} permissions assigned`);

  // Assign permissions to MANAGER role
  await prisma.rolePermission.deleteMany({ where: { roleId: managerRole.id } });
  const managerPermIds = MANAGER_PERMISSIONS.map(code => permMap[code]).filter(Boolean);
  await prisma.rolePermission.createMany({
    data: managerPermIds.map(permissionId => ({ roleId: managerRole.id, permissionId })),
    skipDuplicates: true,
  });
  console.log(`✓ MANAGER role: ${managerPermIds.length} permissions assigned`);

  // Assign permissions to EDITOR role
  await prisma.rolePermission.deleteMany({ where: { roleId: editorRole.id } });
  const editorPermIds = EDITOR_PERMISSIONS.map(code => permMap[code]).filter(Boolean);
  await prisma.rolePermission.createMany({
    data: editorPermIds.map(permissionId => ({ roleId: editorRole.id, permissionId })),
    skipDuplicates: true,
  });
  console.log(`✓ EDITOR role: ${editorPermIds.length} permissions assigned`);

  // Assign permissions to VIEWER role
  await prisma.rolePermission.deleteMany({ where: { roleId: viewerRole.id } });
  const viewerPermIds = VIEWER_PERMISSIONS.map(code => permMap[code]).filter(Boolean);
  await prisma.rolePermission.createMany({
    data: viewerPermIds.map(permissionId => ({ roleId: viewerRole.id, permissionId })),
    skipDuplicates: true,
  });
  console.log(`✓ VIEWER role: ${viewerPermIds.length} permissions assigned`);

  // Ensure default admin user exists with Admin role
  const passwordHash = await bcrypt.hash('Admin@123', 12);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: { name: 'System Admin', username: 'admin', passwordHash, status: 'ACTIVE', mustChangePassword: false },
    create: { name: 'System Admin', email: 'admin@example.com', username: 'admin', passwordHash, status: 'ACTIVE', mustChangePassword: false },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });
  console.log(`✓ Admin user (admin@example.com) has Admin role`);

  // Show final status
  const allUsers = await prisma.user.findMany({
    include: { userRoles: { include: { role: { include: { rolePermissions: true } } } } },
  });

  console.log('\n=== Final User Roles & Permission Count ===');
  for (const user of allUsers) {
    const roleInfo = user.userRoles.map(ur => `${ur.role.name}(${ur.role.rolePermissions.length} perms)`).join(', ');
    console.log(`  ${user.email}: ${roleInfo || 'NO ROLE'}`);
  }

  console.log('\n✅ Fix completed successfully!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
