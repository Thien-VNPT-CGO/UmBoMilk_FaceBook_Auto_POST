import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import path from 'path';

loadEnv({ path: path.resolve(process.cwd(), '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  DATABASE_URL: z.string().min(5).default('postgresql://facebook_automation:Spl2qdMQUAW4NgnKow8BbucGI3RYrV51@localhost:5432/facebook_automation?schema=public'),
  REDIS_URL: z.string().optional().default('redis://localhost:6379'),
  JWT_SECRET: z.string().default('fb_automation_super_secret_jwt_key_2026'),
  JWT_REFRESH_SECRET: z.string().default('fb_automation_super_secret_refresh_jwt_key_2026'),
  ENCRYPTION_KEY: z.string().default('12345678901234567890123456789012'),
  AI_PROVIDER: z.string().optional().default('9router'),
  AI_API_KEY: z.string().optional().default('sk-53efd6fb0fc112f3-bmzho9-0dcd7de6'),
  AI_API_BASE_URL: z.string().optional().default('http://localhost:20128/v1'),
  AI_MODEL: z.string().optional().default('COMBO_API_ALL'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment variables');
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';