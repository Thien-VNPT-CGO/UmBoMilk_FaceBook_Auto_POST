import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { errorHandler } from './common/middleware/errorHandler';
import authRoutes from './modules/auth/auth.routes';
import usersRoutes from './modules/users/users.routes';
import rolesRoutes from './modules/roles/roles.routes';
import facebookPagesRoutes from './modules/facebook-pages/facebook-pages.routes';
import campaignsRoutes from './modules/campaigns/campaigns.routes';
import reportsRoutes from './modules/reports/reports.routes';
import postsRoutes from './modules/posts/posts.routes';
import mediaRoutes from './modules/media/media.routes';
import scheduleRoutes from './modules/schedule/schedule.routes';
import approvalRoutes from './modules/approval/approval.routes';
import permissionsRoutes from './modules/permissions/permissions.routes';
import settingsRoutes from './modules/settings/settings.routes';
import brandingRoutes from './modules/branding/branding.routes';
import logsRoutes from './modules/logs/logs.routes';

export function createApp(): express.Express {
  const app = express();

  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Static uploads directory for media files
  const uploadsDir = path.join(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsDir));

  // Static frontend directory serving
  const possibleFrontendDirs = [
    path.join(process.cwd(), 'frontend'),
    path.join(process.cwd(), '..', 'frontend'),
    path.join(__dirname, '../../frontend')
  ];
  let frontendDir = possibleFrontendDirs.find(d => {
    try { return fs.existsSync(d); } catch { return false; }
  }) || possibleFrontendDirs[0];

  app.use(express.static(frontendDir));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'facebook-automation-backend' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/roles', rolesRoutes);
  app.use('/api/permissions', permissionsRoutes);
  app.use('/api/facebook-pages', facebookPagesRoutes);
  app.use('/api/campaigns', campaignsRoutes);
  app.use('/api/posts', postsRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/schedule', scheduleRoutes);
  app.use('/api/approval-queue', approvalRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/settings/branding', brandingRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/logs', logsRoutes);

  // Fallback to frontend index.html for SPA routes
  app.get('*', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  app.use(errorHandler);
  return app;
}