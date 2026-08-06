import Redis from 'ioredis';
import { env } from '../config/env';

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redisConnection.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('❌ Redis Connection Error:', err);
});