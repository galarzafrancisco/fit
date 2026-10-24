import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/env.config';
import { TokenCipher } from '../common/secrets';

/**
 * Encrypts provider tokens and PKCE verifiers at rest (AES-256-GCM,
 * TOKEN_ENCRYPTION_KEY). The row ID is bound as associated data, so a
 * ciphertext copied to another row does not decrypt.
 */
@Injectable()
export class TokenVault {
  private readonly cipher: TokenCipher;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.cipher = new TokenCipher(config.tokenEncryptionKey);
  }

  encrypt(plaintext: string, rowId: string): string {
    return this.cipher.encrypt(plaintext, rowId);
  }

  /** Null when the value cannot be decrypted (rotated key, tampered, other row) */
  tryDecrypt(ciphertext: string | null, rowId: string): string | null {
    if (!ciphertext) return null;
    try {
      return this.cipher.decrypt(ciphertext, rowId);
    } catch {
      return null;
    }
  }
}
