import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { AuthenticatedRequest } from '../../common/guards/auth.guard';
import { z } from 'zod';
import { BadRequestError } from '../../common/utils/errors';

const authService = new AuthService();

const loginSchema = z.object({
  usernameOrEmail: z.string().optional(),
  email: z.string().optional(),
  password: z.string().min(1, 'Mật khẩu không được để trống'),
}).refine(data => data.usernameOrEmail || data.email, {
  message: 'Cần cung cấp username hoặc email'
});

export const login = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = loginSchema.parse(req.body);
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];

    const result = await authService.login(validatedData, ip, userAgent);
    
    // Set secure HTTP-only cookie for refresh token as required by Section 23
    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({
      success: true,
      data: {
        accessToken: result.accessToken,
        user: result.user
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      next(new BadRequestError(error.errors[0].message));
    } else {
      next(error);
    }
  }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    const result = await authService.refreshToken(token);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      data: {
        accessToken: result.accessToken
      }
    });
  } catch (error) {
    next(error);
  }
};

export const logout = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies.refreshToken || req.body.refreshToken;
    const userId = req.user!.id;
    
    const result = await authService.logout(userId, token);
    
    res.clearCookie('refreshToken');
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const changePassword = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await authService.changePassword(req.user!.id, req.body);
    res.clearCookie('refreshToken'); // Force re-login after password change
    res.json(result);
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestError('Không tìm thấy thông tin tài khoản đăng nhập');
    const { prisma } = await import('../../common/database/prisma');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        userRoles: { include: { role: true } }
      }
    });

    if (!user) throw new BadRequestError('Không tìm thấy người dùng');

    const roles = user.userRoles.map(ur => ur.role.name);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        username: user.username,
        status: user.status,
        roles: roles.length ? roles : ['ADMIN'],
      }
    });
  } catch (err) {
    next(err);
  }
};