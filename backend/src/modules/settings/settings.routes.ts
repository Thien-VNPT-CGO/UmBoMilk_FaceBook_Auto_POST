import { Router } from 'express';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { requireAuth, AuthenticatedRequest } from '../../common/guards/auth.guard';
import { requirePermission } from '../../common/guards/rbac.guard';
import { prisma } from '../../common/database/prisma';
import { ForbiddenError } from '../../common/utils/errors';

const router = Router();

// Helper to update & persist AI configuration in backend/.env file
function updateEnvFile(aiConfig: { provider?: string; baseUrl?: string; apiKey?: string; model?: string }) {
  try {
    const envPath = path.resolve(__dirname, '../../../.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const updateOrAppend = (key: string, val: string) => {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}="${val}"`);
      } else {
        envContent += `\n${key}="${val}"`;
      }
    };

    if (aiConfig.provider) {
      updateOrAppend('AI_PROVIDER', aiConfig.provider);
      process.env.AI_PROVIDER = aiConfig.provider;
    }
    if (aiConfig.baseUrl) {
      updateOrAppend('AI_API_BASE_URL', aiConfig.baseUrl);
      process.env.AI_API_BASE_URL = aiConfig.baseUrl;
    }
    if (aiConfig.apiKey !== undefined) {
      updateOrAppend('AI_API_KEY', aiConfig.apiKey);
      process.env.AI_API_KEY = aiConfig.apiKey;
    }
    if (aiConfig.model) {
      updateOrAppend('AI_MODEL', aiConfig.model);
      process.env.AI_MODEL = aiConfig.model;
    }

    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (err) {
    console.error('[Settings] Error syncing .env file:', err);
  }
}

// GET /settings - List all system settings
router.get('/', requireAuth, requirePermission('setting.view'), async (_req, res, next) => {
  try {
    const settings = await prisma.systemSetting.findMany();
    res.json({ data: settings });
  } catch (err) {
    next(err);
  }
});

// GET /settings/ai-config - Get active AI engine configuration
router.get('/ai-config', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const dbSetting = await prisma.systemSetting.findUnique({ where: { key: 'ai_config' } });
    let config = {
      provider: process.env.AI_PROVIDER || '9router',
      baseUrl: process.env.AI_API_BASE_URL || 'http://localhost:2000/v1',
      apiKey: process.env.AI_API_KEY || '9router-key-local',
      model: process.env.AI_MODEL || 'qwen2.5',
    };

    if (dbSetting && dbSetting.valueJson) {
      const parsed = typeof dbSetting.valueJson === 'string' ? JSON.parse(dbSetting.valueJson) : dbSetting.valueJson;
      config = { ...config, ...parsed };
    }

    // Check if user is Admin
    let isAdmin = false;
    if (req.user?.id) {
      const userRoles = await prisma.userRole.findMany({
        where: { userId: req.user.id },
        include: { role: true },
      });
      isAdmin = userRoles.some(ur => {
        const name = ur.role.name.toUpperCase();
        return name.includes('ADMIN');
      });
    }

    res.json({
      success: true,
      data: config,
      isAdmin,
    });
  } catch (err) {
    next(err);
  }
});

// POST /settings - Update system setting
router.post('/', requireAuth, requirePermission('setting.update'), async (req: AuthenticatedRequest, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { key, valueJson } = req.body;

    // Check Admin permission specifically for ai_config
    if (key === 'ai_config') {
      const userRoles = await prisma.userRole.findMany({
        where: { userId: authReq.user!.id },
        include: { role: true },
      });
      const isAdmin = userRoles.some(ur => {
        const name = ur.role.name.toUpperCase();
        return name.includes('ADMIN');
      });

      if (!isAdmin) {
        throw new ForbiddenError('Chỉ có tài khoản Admin mới được quyền thay đổi cấu hình 9router AI Engine!');
      }

      // Sync & persist to backend .env file and process.env
      const parsed = typeof valueJson === 'string' ? JSON.parse(valueJson) : valueJson;
      updateEnvFile(parsed);
    }

    const setting = await prisma.systemSetting.upsert({
      where: { key },
      update: { valueJson, updatedBy: authReq.user?.id || 'system' },
      create: { key, valueJson, updatedBy: authReq.user?.id || 'system' },
    });

    res.json({ success: true, message: 'Đã lưu cấu hình thành công', data: setting });
  } catch (err) {
    next(err);
  }
});

// POST /settings/test-ai - Test connection to 9router / Local AI
router.post('/test-ai', requireAuth, async (req, res, next) => {
  try {
    const { baseUrl, apiKey, model } = req.body;
    const cleanBaseUrl = (baseUrl || 'http://localhost:2000/v1').trim().replace(/\/+$/, '');
    const endpoint = cleanBaseUrl.endsWith('/chat/completions') ? cleanBaseUrl : `${cleanBaseUrl}/chat/completions`;
    
    const response = await axios.post(
      endpoint,
      {
        model: model || 'qwen2.5',
        messages: [{ role: 'user', content: 'Ping test connection 9router' }],
        max_tokens: 10,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        timeout: 5000,
      }
    );

    res.json({
      success: true,
      message: '🟢 Kết nối tới API Engine AI thành công!',
      data: response.data,
    });
  } catch (err: any) {
    let errorDetail = err.response?.data?.error?.message || err.message;
    if (err.response?.status === 429) {
      errorDetail = `Lỗi 429 (Tài khoản hết số dư / Quota Exceeded). Mã OpenAI API Key này đã hết hạn mức sử dụng miễn phí. Chi tiết: ${errorDetail}`;
    } else if (err.response?.status === 401) {
      errorDetail = `Lỗi 401 (API Key không hợp lệ). Vui lòng kiểm tra lại mã API Key. Chi tiết: ${errorDetail}`;
    }

    res.status(400).json({
      success: false,
      message: `🔴 Lỗi kết nối API AI (${req.body.baseUrl || 'https://api.openai.com/v1'}): ${errorDetail}`,
    });
  }
});

// POST /settings/reset-system-data - Reset ALL data EXCEPT users and facebook pages (Admin only)
router.post('/reset-system-data', requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const authReq = req as AuthenticatedRequest;

    // Verify Admin role strictly
    const userRoles = await prisma.userRole.findMany({
      where: { userId: authReq.user!.id },
      include: { role: true },
    });
    const isAdmin = userRoles.some(ur => ur.role.name.toUpperCase().includes('ADMIN'));

    if (!isAdmin) {
      throw new ForbiddenError('⛔ Chỉ có tài khoản Quản Trị Viên (Admin) mới có quyền Reset dữ liệu hệ thống!');
    }

    // Delete data in correct relational dependency order:
    // 1. Approval History & Content Revision & Post Media
    await prisma.approvalHistory.deleteMany({}).catch(() => {});
    await prisma.contentRevision.deleteMany({}).catch(() => {});
    await prisma.postMedia.deleteMany({}).catch(() => {});
    // 2. Generated Posts
    await prisma.generatedPost.deleteMany({}).catch(() => {});
    // 3. Campaign Pages
    await prisma.campaignPage.deleteMany({}).catch(() => {});
    // 4. Campaigns
    await prisma.campaign.deleteMany({}).catch(() => {});
    // 5. Media Files
    await prisma.mediaFile.deleteMany({}).catch(() => {});
    // 6. Job Logs & Audit Logs
    await prisma.jobLog.deleteMany({}).catch(() => {});
    await prisma.auditLog.deleteMany({}).catch(() => {});

    // Empty BullMQ queues
    try {
      const { postSchedulingQueue, contentGenerationQueue } = await import('../../common/queue/queues');
      await postSchedulingQueue.drain().catch(() => {});
      await contentGenerationQueue.drain().catch(() => {});
    } catch (e) {}

    // Audit log entry for data reset
    await prisma.auditLog.create({
      data: {
        userId: authReq.user!.id,
        action: 'SYSTEM_RESET',
        entityType: 'DATABASE',
      },
    }).catch(() => {});

    res.json({
      success: true,
      message: '🧹 ĐÃ RESET TOÀN BỘ DỮ LIỆU THÀNH CÔNG! Tất cả bài viết, chiến dịch, kho media và nhật ký log đã được dọn dẹp sạch sẽ (Tài khoản & Facebook Page được giữ nguyên).',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
