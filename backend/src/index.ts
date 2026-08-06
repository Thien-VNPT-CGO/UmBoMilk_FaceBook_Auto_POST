import { createApp } from './app';
import { env } from './common/config/env';
import { logger } from './common/utils/logger';
import { prisma } from './common/database/prisma';

async function bootstrap() {
  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (err) {
    logger.error('Database connection failed', err);
    process.exit(1);
  }

  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info(`HTTP server listening on port ${env.PORT}`);
  });
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failure', err);
  process.exit(1);
});