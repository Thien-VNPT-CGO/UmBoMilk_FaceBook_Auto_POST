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

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedError('Người dùng không tồn tại hoặc đã bị khóa');
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