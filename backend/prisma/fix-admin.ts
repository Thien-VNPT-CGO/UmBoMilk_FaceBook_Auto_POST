import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Find admin role
  const adminRole = await prisma.role.findFirst({ where: { name: 'Admin' } });
  if (!adminRole) {
    console.log('Admin role not found! Run seed first.');
    return;
  }

  // Find all users
  const users = await prisma.user.findMany({
    include: { userRoles: true },
  });

  console.log(`Found ${users.length} users`);

  for (const user of users) {
    console.log(`User: ${user.email} (${user.id}) - Roles: ${user.userRoles.length}`);
    
    if (user.userRoles.length === 0) {
      // Assign admin role to users without any role
      await prisma.userRole.create({
        data: { userId: user.id, roleId: adminRole.id },
      });
      console.log(`  -> Assigned Admin role to ${user.email}`);
    }
  }

  // List all users with their roles
  const allUsers = await prisma.user.findMany({
    include: { 
      userRoles: { include: { role: true } }
    },
  });

  console.log('\n=== Current User Roles ===');
  for (const user of allUsers) {
    console.log(`${user.email}: ${user.userRoles.map(ur => ur.role.name).join(', ') || 'NO ROLE'}`);
  }

  // Check role permissions
  const adminRoleWithPerms = await prisma.role.findFirst({
    where: { name: 'Admin' },
    include: { rolePermissions: { include: { permission: true } } },
  });
  console.log(`\nAdmin role has ${adminRoleWithPerms?.rolePermissions.length || 0} permissions`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
