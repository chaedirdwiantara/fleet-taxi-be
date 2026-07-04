import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { Env } from '../config/env';
import { DatabaseService } from '../db/database.service';
import { apiKeys, partners } from '../db/schema';

export interface AuthenticatedPartner {
  id: number;
  code: string;
  name: string;
  scopes: string[];
  rateLimit: number | null;
  apiKeyId: number;
}

const KEY_PREFIX_LEN = 12; // "ftk_" + 8 chars, non-secret, for O(1) lookup

@Injectable()
export class ApiKeysService {
  private readonly pepper: Buffer;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Env, true>,
  ) {
    this.pepper = Buffer.from(config.get('API_KEY_PEPPER', { infer: true }));
  }

  /** Creates a key; the raw value is returned ONCE and never stored. */
  async createKey(input: {
    partnerId: number;
    label?: string;
    scopes?: string[];
    rateLimit?: number;
  }): Promise<{ rawKey: string; keyPrefix: string; id: number }> {
    const rawKey = `ftk_${nanoid(40)}`;
    const keyPrefix = rawKey.slice(0, KEY_PREFIX_LEN);
    const keyHash = await argon2.hash(rawKey, { secret: this.pepper });

    const [row] = await this.database.db
      .insert(apiKeys)
      .values({
        partnerId: input.partnerId,
        keyHash,
        keyPrefix,
        label: input.label,
        scopes: input.scopes ?? [],
        rateLimit: input.rateLimit,
      })
      .returning({ id: apiKeys.id });

    return { rawKey, keyPrefix, id: row!.id };
  }

  /** Verifies a presented key; returns the owning partner or null. */
  async verifyKey(rawKey: string): Promise<AuthenticatedPartner | null> {
    if (!rawKey.startsWith('ftk_') || rawKey.length < KEY_PREFIX_LEN + 8) return null;
    const keyPrefix = rawKey.slice(0, KEY_PREFIX_LEN);

    const candidates = await this.database.db
      .select({
        id: apiKeys.id,
        keyHash: apiKeys.keyHash,
        scopes: apiKeys.scopes,
        rateLimit: apiKeys.rateLimit,
        partnerId: partners.id,
        partnerCode: partners.code,
        partnerName: partners.name,
      })
      .from(apiKeys)
      .innerJoin(partners, eq(partners.id, apiKeys.partnerId))
      .where(
        and(
          eq(apiKeys.keyPrefix, keyPrefix),
          isNull(apiKeys.revokedAt),
          eq(partners.isActive, true),
        ),
      );

    for (const c of candidates) {
      const ok = await argon2.verify(c.keyHash, rawKey, { secret: this.pepper }).catch(() => false);
      if (ok) {
        // fire-and-forget usage stamp; never blocks the request
        void this.database.db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.id, c.id))
          .catch(() => undefined);
        return {
          id: c.partnerId,
          code: c.partnerCode,
          name: c.partnerName,
          scopes: c.scopes,
          rateLimit: c.rateLimit,
          apiKeyId: c.id,
        };
      }
    }
    return null;
  }

  async revokeKey(id: number): Promise<void> {
    await this.database.db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
  }
}
