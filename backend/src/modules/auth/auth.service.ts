import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../common/database/prisma';
import { env } from '../../common/config/env';
import { UnauthorizedError, BadRequestError, NotFoundError } from '../../common/utils/errors';
import { hashToken } from '../../common/encryption/crypto';
import { createAuditLog } from '../../common/utils/audit';

export class AuthService {
  async login(data: { usernameOrEmail?: string; email?: string; password?: string }, ipAddress?: string, userAgent?: string) {
    const account = data.usernameOrEmail || data.email;
    if (!account || !data.password) {
      throw new BadRequestError('Vui lòng nhập tài khoản và mật khẩu');
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: account }, { username: account }],
      },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!user) {
      // Không thể ghi LoginHistory vì bảng yêu cầu userId hợp lệ.
      // Tránh dùng một UUID giả làm phát sinh lỗi khóa ngoại.
      throw new UnauthorizedError('Tài khoản hoặc mật khẩu không chính xác');
    }

    if (user.status !== 'ACTIVE') {
      await prisma.loginHistory.create({
        data: {
          userId: user.id,
          ipAddress: ipAddress || 'unknown',
          userAgent: userAgent || 'unknown',
          success: false,
          failureReason: 'Tài khoản bị khóa hoặc vô hiệu hóa',
        },
      });
      throw new UnauthorizedError('Tài khoản của bạn đã bị khóa');
    }

    const isMatch = await bcrypt.compare(data.password, user.passwordHash);
    if (!isMatch) {
      await prisma.loginHistory.create({
        data: {
          userId: user.id,
          ipAddress: ipAddress || 'unknown',
          userAgent: userAgent || 'unknown',
          success: false,
          failureReason: 'Mật khẩu sai',
        },
      });
      throw new UnauthorizedError('Tài khoản hoặc mật khẩu không chính xác');
    }

    // Update lastLoginAt
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Record login history
    await prisma.loginHistory.create({
      data: {
        userId: user.id,
        ipAddress: ipAddress || 'unknown',
        userAgent: userAgent || 'unknown',
        success: true,
      },
    });

    // Create tokens
    const accessToken = jwt.sign({ userId: user.id }, env.JWT_SECRET, { expiresIn: '1d' });
    const refreshToken = jwt.sign({ userId: user.id }, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

    // Store refresh token
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await createAuditLog({
      userId: user.id,
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: user.id,
      ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        mustChangePassword: user.mustChangePassword,
        roles: user.userRoles.length ? user.userRoles.map((ur) => ur.role.name) : ['ADMIN'],
      },
    };
  }

  async refreshToken(refreshToken: string) {
    if (!refreshToken) {
      throw new BadRequestError('Cần cung cấp Refresh Token');
    }

    try {
      const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { userId: string };
      const tokenHash = hashToken(refreshToken);

      const storedToken = await prisma.refreshToken.findFirst({
        where: {
          userId: decoded.userId,
          tokenHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });

      if (!storedToken) {
        throw new UnauthorizedError('Refresh Token không hợp lệ hoặc đã bị thu hồi');
      }

      // Check user active
      const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedError('Tài khoản không hợp lệ');
      }

      // Revoke old refresh token and issue new pair
      await prisma.refreshToken.update({
        where: { id: storedToken.id },
        data: { revokedAt: new Date() },
      });

      const newAccessToken = jwt.sign({ userId: user.id }, env.JWT_SECRET, { expiresIn: '1d' });
      const newRefreshToken = jwt.sign({ userId: user.id }, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(newRefreshToken),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      };
    } catch (err) {
      throw new UnauthorizedError('Refresh Token hết hạn hoặc không hợp lệ');
    }
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      await prisma.refreshToken.updateMany({
        where: { userId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    await createAuditLog({
      userId,
      action: 'USER_LOGOUT',
      entityType: 'User',
      entityId: userId,
    });

    return { success: true, message: 'Đăng xuất thành công' };
  }

  async changePassword(userId: string, data: { oldPassword?: string; newPassword?: string }) {
    if (!data.oldPassword || !data.newPassword) {
      throw new BadRequestError('Vui lòng nhập mật khẩu cũ và mật khẩu mới');
    }

    if (data.newPassword.length < 6) {
      throw new BadRequestError('Mật khẩu mới phải có tối thiểu 6 ký tự');
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('Không tìm thấy người dùng');

    const isMatch = await bcrypt.compare(data.oldPassword, user.passwordHash);
    if (!isMatch) {
      throw new BadRequestError('Mật khẩu cũ không chính xác');
    }

    const newHash = await bcrypt.hash(data.newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newHash,
        mustChangePassword: false,
      },
    });

    // Revoke all existing sessions
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await createAuditLog({
      userId,
      action: 'CHANGE_PASSWORD',
      entityType: 'User',
      entityId: userId,
    });

    return { success: true, message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.' };
  }
}