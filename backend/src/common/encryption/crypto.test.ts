import { describe, it, expect } from 'vitest';
import { encryptString, decryptString } from './crypto';

describe('Crypto Utility', () => {
  it('thực hiện mã hóa và giải mã chuỗi thành công', () => {
    const originalText = 'EAAXxxxxFacebookAccessTokenSecret123';
    const encrypted = encryptString(originalText);
    expect(encrypted).not.toBe(originalText);
    expect(typeof encrypted).toBe('string');

    const decrypted = decryptString(encrypted);
    expect(decrypted).toBe(originalText);
  });

  it('trả về chuỗi rỗng nếu giải mã input không hợp lệ', () => {
    const decrypted = decryptString('');
    expect(decrypted).toBe('');
  });
});