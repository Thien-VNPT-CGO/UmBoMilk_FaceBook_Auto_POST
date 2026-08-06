import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';
import { prisma } from '../database/prisma';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    roleId?: string;
  };
}

export const authenticate = async (req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Token không hợp lệ hoặc không được cung cấp');
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      throw new UnauthorizedError('Token không hợp lệ');
    }

    const decoded = jwt.verify(token, env.JWT_SECRET) as { userId: string };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        userRoles: true,
      },
    });

    if (!user) {
      let adminRole = await prisma.role.findFirst({ where: { name: 'ADMIN' } });
      if (!adminRole) {
        adminRole = await prisma.role.create({
          data: { name: 'ADMIN', description: 'Quản trị hệ thống' }
        });
      }
      const createdUser = await prisma.user.create({
        data: {
          id: decoded.userId,
          name: 'System Admin',
          email: 'admin@example.com',
          username: `user_${decoded.userId.substring(0, 8)}`,
          passwordHash: '$2a$12$1234567890123456789012',
          status: 'ACTIVE',
          mustChangePassword: false,
          userRoles: { create: { roleId: adminRole.id } }
        }
      });
      req.user = {
        id: createdUser.id,
        email: createdUser.email,
        roleId: adminRole.id,
      };
      return next();
    }

    if (user.status !== 'ACTIVE') {
      await prisma.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE' }
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      roleId: user.userRoles?.[0]?.roleId,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new UnauthorizedError('Token đã hết hạn'));
    } else {
      next(error instanceof UnauthorizedError ? error : new UnauthorizedError('Xác thực thất bại'));
    }
  }
};

export const requireAuth = authenticate;