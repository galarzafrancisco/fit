import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random, URL-safe secret of `bytes` bytes */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex digest. Cookies and `state` are stored only as this. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * AES-256-GCM for tokens at rest. `context` (the row ID) is bound as
 * associated data, so a ciphertext copied to another row does not decrypt.
 */
export class TokenCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('TokenCipher needs a 32-byte key');
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  /** Throws when the value was tampered with, belongs to another row or was encrypted with another key */
  decrypt(value: string, context: string): string {
    const [version, iv, tag, data] = value.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognised ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }
}
