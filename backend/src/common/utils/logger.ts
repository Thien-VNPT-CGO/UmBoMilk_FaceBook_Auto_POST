/* eslint-disable no-console */

// Safe logging utils that do not write tokens, secrets or sensitive info to logs (Section 3 & Section 23)
export const logger = {
  info: (message: string, meta?: Record<string, any>) => {
    const cleanMeta = sanitizeMeta(meta);
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, cleanMeta ? JSON.stringify(cleanMeta) : '');
  },
  warn: (message: string, meta?: Record<string, any>) => {
    const cleanMeta = sanitizeMeta(meta);
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, cleanMeta ? JSON.stringify(cleanMeta) : '');
  },
  error: (message: string, error?: any, meta?: Record<string, any>) => {
    const cleanMeta = sanitizeMeta(meta);
    const errDetails = error instanceof Error ? { message: error.message, stack: error.stack } : error;
    console.error(
      `[ERROR] ${new Date().toISOString()} - ${message}`,
      JSON.stringify({ error: errDetails, ...cleanMeta })
    );
  },
};

const SENSITIVE_KEYS = [
  'token',
  'accesstoken',
  'password',
  'secret',
  'hash',
  'key',
  'authorization',
  'cookie',
  'credential',
];

function sanitizeMeta(meta?: Record<string, any>): Record<string, any> | undefined {
  if (!meta) return undefined;
  const copy = { ...meta };
  for (const key of Object.keys(copy)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((s) => lowerKey.includes(s))) {
      copy[key] = '[REDACTED]';
    } else if (typeof copy[key] === 'object' && copy[key] !== null) {
      copy[key] = sanitizeMeta(copy[key]);
    }
  }
  return copy;
}