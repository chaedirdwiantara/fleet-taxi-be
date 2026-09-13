import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Env } from '../config/env';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export class CredentialCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialCipherError';
  }
}

/**
 * AES-256-GCM at rest for the portal credential digest. The 256-bit key is
 * derived (SHA-256) from GOJEK_PORTAL_ENCRYPTION_KEY so operators can paste
 * any strong random string. Ciphertext format: `v1:<iv>:<tag>:<data>` (base64).
 */
@Injectable()
export class CredentialCipher {
  private readonly key: Buffer | null;

  constructor(config: ConfigService<Env, true>) {
    const secret = config.get('GOJEK_PORTAL_ENCRYPTION_KEY', { infer: true });
    this.key = secret ? createHash('sha256').update(secret, 'utf8').digest() : null;
  }

  /** False until the env secret is registered — the UI shows a setup hint. */
  isConfigured(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(
      ':',
    );
  }

  decrypt(ciphertext: string): string {
    const key = this.requireKey();
    const [version, ivB64, tagB64, dataB64] = ciphertext.split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
      throw new CredentialCipherError('Format kredensial tersimpan tidak dikenal.');
    }
    try {
      const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Key rotated (or ciphertext tampered): the digest is unrecoverable.
      throw new CredentialCipherError(
        'Kata sandi portal tersimpan tidak bisa dibaca (kunci enkripsi berubah). Isi ulang kata sandi.',
      );
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new CredentialCipherError(
        'GOJEK_PORTAL_ENCRYPTION_KEY belum diatur di server — kata sandi portal belum bisa disimpan.',
      );
    }
    return this.key;
  }
}
