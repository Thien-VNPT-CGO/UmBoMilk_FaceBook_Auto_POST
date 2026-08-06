import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { logger } from './logger';

export async function createAuditLog(params: {
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  oldValue?: any;
  newValue?: any;
  ipAddress?: string;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        oldValue: params.oldValue ? params.oldValue : Prisma.DbNull,
        newValue: params.newValue ? params.newValue : Prisma.DbNull,
        ipAddress: params.ipAddress,
      },
    });
  } catch (error) {
    logger.error('Thất bại khi ghi AuditLog', error);
  }
}
