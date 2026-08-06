import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { UsersService } from './users.service';
import { AuthenticatedRequest } from '../../common/guards/auth.guard';
import { BadRequestError } from '../../common/utils/errors';
import { prisma } from '../../common/database/prisma';

const usersService = new UsersService();

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  username: z.string().min(3).optional(),
  phone: z.string().optional(),
  password: z.string().min(6),
  roleIds: z.array(z.string()).optional(),
  roleName: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional(),
  status: z.enum(['ACTIVE', 'LOCKED', 'INACTIVE']).optional(),
  password: z.string().min(6).optional(),
  roleIds: z.array(z.string()).optional(),
});

export const list = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await usersService.list({
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      search: req.query.search as string | undefined,
      status: req.query.status as string | undefined,
    });
    res.json({ success: true, data: result });
  } catch (e) {
    next(e);
  }
};

export const get = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await usersService.getById(req.params.id);
    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
};

export const create = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body;
    if (!body.username) {
      body.username = body.email ? body.email.split('@')[0] : `user_${Date.now()}`;
    }

    const targetRoleName = String(body.roleName || body.role || '').toUpperCase();
    let finalRoleIds: string[] = Array.isArray(body.roleIds) && body.roleIds.length ? body.roleIds : [];

    if (finalRoleIds.length === 0 && targetRoleName) {
      let role = await prisma.role.findFirst({
        where: {
          OR: [
            { name: { equals: targetRoleName, mode: 'insensitive' } },
            { name: { contains: targetRoleName, mode: 'insensitive' } },
          ],
        },
      });

      if (!role) {
        role = await prisma.role.create({
          data: { name: targetRoleName, description: `Vai trò ${targetRoleName}` },
        });
      }
      finalRoleIds = [role.id];
    }

    body.roleIds = finalRoleIds;
    const data = createSchema.parse(body);
    const userId = await usersService.create({
      name: data.name,
      email: data.email,
      username: data.username || data.email.split('@')[0],
      phone: data.phone,
      password: data.password,
      roleIds: finalRoleIds,
    }, req.user!.id, req.ip);
    res.status(201).json({ success: true, data: { id: userId } });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
    next(e);
  }
};

export const update = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = updateSchema.parse(req.body);
    await usersService.update(req.params.id, data, req.user!.id, req.ip);
    res.json({ success: true, message: 'Cập nhật người dùng thành công' });
  } catch (e) {
    if (e instanceof z.ZodError) return next(new BadRequestError(e.errors[0].message));
    next(e);
  }
};

export const remove = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await usersService.delete(req.params.id, req.user!.id, req.ip);
    res.json({ success: true, message: 'Đã xóa người dùng' });
  } catch (e) {
    next(e);
  }
};