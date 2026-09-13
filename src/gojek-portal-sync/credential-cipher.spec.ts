import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { CredentialCipher, CredentialCipherError } from './credential-cipher';

const withKey = (key: string | undefined) =>
  new CredentialCipher({ get: () => key } as unknown as ConfigService);

describe('CredentialCipher (AES-256-GCM)', () => {
  it('round-trips and never stores the plaintext', () => {
    const cipher = withKey('a-strong-random-key-for-tests-0123456789');
    const digest = 'NWY0ZGNjM2I1YWE3NjVkNjFkODMyN2RlYjg4MmNmOTk=';
    const enc = cipher.encrypt(digest);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain(digest);
    expect(cipher.decrypt(enc)).toBe(digest);
    // fresh IV each time → different ciphertext for the same input
    expect(cipher.encrypt(digest)).not.toBe(enc);
  });

  it('refuses tampered ciphertext and a rotated key', () => {
    const cipher = withKey('a-strong-random-key-for-tests-0123456789');
    const enc = cipher.encrypt('secret-digest');
    const [v, iv, tag, data] = enc.split(':');
    const flipped = Buffer.from(data!, 'base64');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString('base64')].join(':'))).toThrow(
      CredentialCipherError,
    );
    expect(() => withKey('another-key-entirely-0123456789abcdef').decrypt(enc)).toThrow(
      /kunci enkripsi berubah/,
    );
    expect(() => cipher.decrypt('garbage')).toThrow(CredentialCipherError);
  });

  it('reports "not configured" without the env secret and refuses to encrypt', () => {
    const cipher = withKey(undefined);
    expect(cipher.isConfigured()).toBe(false);
    expect(() => cipher.encrypt('x')).toThrow(/GOJEK_PORTAL_ENCRYPTION_KEY/);
  });
});
