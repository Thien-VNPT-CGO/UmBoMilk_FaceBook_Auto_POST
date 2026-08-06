import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../common/database/prisma';
import { BadRequestError, NotFoundError, ConflictError } from '../../common/utils/errors';
import { createAuditLog } from '../../common/utils/audit';

export interface CreateUserInput {
  name: string;
  email: string;
  username: string;
  phone?: string;
  password: string;
  roleIds: string[];
}

export interface UpdateUserInput {
  name?: string;
  phone?: string;
  status?: string;
  password?: string;
  roleIds?: string[];
}

export class UsersService {
  async list(params: { page?: number; limit?: number; search?: string; status?: string }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const where: Prisma.UserWhereInput = {};
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
        { username: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.status) where.status = params.status;

    const [total, items] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        include: {
          userRoles: { include: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      items: items.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        phone: user.phone,
        status: user.status,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        roles: user.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundError('Không tìm thấy người dùng');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      phone: user.phone,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      roles: user.userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
    };
  }

  async create(data: CreateUserInput, actorId: string, ip?: string) {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: data.email }, { username: data.username }] },
    });
    if (existing) throw new ConflictError('Email hoặc username đã tồn tại');
    if (data.password.length < 6) throw new BadRequestError('Mật khẩu tối thiểu 6 ký tự');

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        username: data.username,
        phone: data.phone,
        passwordHash,
        createdBy: actorId,
        userRoles: {
          create: data.roleIds.map((roleId) => ({ roleId })),
        },
      },
    });

    await createAuditLog({
      userId: actorId,
      action: 'USER_CREATE',
      entityType: 'User',
      entityId: user.id,
      newValue: { name: user.name, email: user.email },
      ipAddress: ip,
    });

    return user.id;
  }

  async update(id: string, data: UpdateUserInput, actorId: string, ip?: string) {
    const user = await prisma.user.findUnique({ where: { id }, include: { userRoles: true } });
    if (!user) throw new NotFoundError('Không tìm thấy người dùng');

    const updateData: Prisma.UserUpdateInput = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.password) {
      if (data.password.length < 6) throw new BadRequestError('Mật khẩu tối thiểu 6 ký tự');
      updateData.passwordHash = await bcrypt.hash(data.password, 12);
      updateData.mustChangePassword = true;
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: updateData });
      if (data.roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        await tx.userRole.createMany({
          data: data.roleIds.map((roleId) => ({ userId: id, roleId })),
          skipDuplicates: true,
        });
      }
    });

    await createAuditLog({
      userId: actorId,
      action: 'USER_UPDATE',
      entityType: 'User',
      entityId: id,
      oldValue: { status: user.status, name: user.name },
      newValue: data,
      ipAddress: ip,
    });

    return true;
  }

  async delete(id: string, actorId: string, ip?: string) {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('Không tìm thấy người dùng');
    
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: id } }),
      prisma.userPermission.deleteMany({ where: { userId: id } }),
      prisma.userFacebookPage.deleteMany({ where: { userId: id } }),
      prisma.loginHistory.deleteMany({ where: { userId: id } }),
      prisma.refreshToken.deleteMany({ where: { userId: id } }),
      prisma.auditLog.deleteMany({ where: { userId: id } }),
      prisma.contentRevision.deleteMany({ where: { editedByUserId: id } }),
      prisma.approvalHistory.deleteMany({ where: { performedByUserId: id } }),
      prisma.user.delete({ where: { id } }),
    ]);

    await createAuditLog({
      userId: actorId,
      action: 'USER_DELETE',
      entityType: 'User',
      entityId: id,
      ipAddress: ip,
    });
    return true;
  }
}