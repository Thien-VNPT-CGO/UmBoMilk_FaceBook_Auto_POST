import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const permissions = [
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
  ['log.view', 'Xem nhật ký hệ thống', 'LOGS'],
  ['audit.view', 'Xem Audit Log', 'LOGS'],

  // Settings
  ['setting.view', 'Xem cài đặt hệ thống', 'SETTINGS'],
  ['setting.update', 'Cập nhật cài đặt', 'SETTINGS'],
  ['branding.update', 'Cập nhật nhận diện thương hiệu', 'SETTINGS'],
  ['ai_setting.update', 'Cập nhật cấu hình AI', 'SETTINGS'],
];

async function main() {
  // Create system roles
  const adminRole = await prisma.role.upsert({
    where: { name: 'Admin' },
    update: { description: 'Toàn quyền hệ thống', isSystemRole: true },
    create: { name: 'Admin', description: 'Toàn quyền hệ thống', isSystemRole: true },
  });

  const editorRole = await prisma.role.upsert({
    where: { name: 'Content Editor' },
    update: { description: 'Xem, chỉnh sửa, tạo lại và gửi duyệt nội dung', isSystemRole: true },
    create: { name: 'Content Editor', description: 'Xem, chỉnh sửa, tạo lại và gửi duyệt nội dung', isSystemRole: true },
  });

  const approverRole = await prisma.role.upsert({
    where: { name: 'Content Approver' },
    update: { description: 'Xem, duyệt, từ chối nội dung bài viết', isSystemRole: true },
    create: { name: 'Content Approver', description: 'Xem, duyệt, từ chối nội dung bài viết', isSystemRole: true },
  });

  const operatorRole = await prisma.role.upsert({
    where: { name: 'Page Operator' },
    update: { description: 'Quản lý lịch đăng, kích hoạt/tạm dừng và theo dõi lỗi trên Page được gán', isSystemRole: true },
    create: { name: 'Page Operator', description: 'Quản lý lịch đăng, kích hoạt/tạm dừng và theo dõi lỗi trên Page được gán', isSystemRole: true },
  });

  const viewerRole = await prisma.role.upsert({
    where: { name: 'Viewer' },
    update: { description: 'Xem thông tin dashboard, lịch và báo cáo', isSystemRole: true },
    create: { name: 'Viewer', description: 'Xem thông tin dashboard, lịch và báo cáo', isSystemRole: true },
  });

  // Seed permissions
  const seededPermissions = await Promise.all(
    permissions.map(([code, name, module]) =>
      prisma.permission.upsert({
        where: { code },
        update: { name, module },
        create: { code, name, module },
      })
    )
  );

  // Assign ALL permissions to Admin
  await prisma.rolePermission.deleteMany({ where: { roleId: adminRole.id } });
  await prisma.rolePermission.createMany({
    data: seededPermissions.map((permission) => ({
      roleId: adminRole.id,
      permissionId: permission.id,
    })),
    skipDuplicates: true,
  });

  // Create default Admin user
  const passwordHash = await bcrypt.hash('Admin@123', 12);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {
      name: 'System Admin',
      username: 'admin',
      passwordHash,
      status: 'ACTIVE',
      mustChangePassword: false,
    },
    create: {
      name: 'System Admin',
      email: 'admin@example.com',
      username: 'admin',
      passwordHash,
      status: 'ACTIVE',
      mustChangePassword: false,
    },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });

  // Default branding system setting
  await prisma.systemSetting.upsert({
    where: { key: 'branding' },
    update: {},
    create: {
      key: 'branding',
      valueJson: {
        systemName: 'UmBoMilk - Marketing Auto-Post Page Facebook',
        copyright: '© 2026. All rights reserved.',
        logoUrl: 'logo.jpg',
      },
    },
  });

  console.log('Seed completed successfully. Admin login: admin@example.com / Admin@123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });