/**
 * M5 auth + rate-limit edge cases against the real stack.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { partners, roles, users } from '../src/db/schema';
import { ApiKeysService } from '../src/partners/api-keys.service';

const RUN = `hard${Date.now()}`;
const PASSWORD = 'hardening-pw';

describe('hardening: auth + rate-limit edge cases (M5)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let apiKeysService: ApiKeysService;
  let partnerId: number;
  let inactivePartnerId: number;
  const userIds: number[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    apiKeysService = app.get(ApiKeysService);
    const { db } = database;

    await db
      .insert(roles)
      .values([{ name: 'partner' }])
      .onConflictDoNothing();

    const [p] = await db
      .insert(partners)
      .values({ code: `${RUN}-P`, name: 'Rate Partner', type: 'shuttle' })
      .returning();
    partnerId = p!.id;

    const [ip] = await db
      .insert(partners)
      .values({ code: `${RUN}-IP`, name: 'Inactive Partner', type: 'shuttle', isActive: false })
      .returning();
    inactivePartnerId = ip!.id;

    const [inactiveUser] = await db
      .insert(users)
      .values({
        email: `${RUN}-inactive@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        isActive: false,
      })
      .returning();
    userIds.push(inactiveUser!.id);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(partners).where(inArray(partners.id, [partnerId, inactivePartnerId]));
    await app.close();
  });

  it('rejects login for an inactive user (same generic 401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: `${RUN}-inactive@test.example`, password: PASSWORD })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toBe('Invalid credentials');
  });

  it('rejects an API key whose partner has been deactivated', async () => {
    const { rawKey } = await apiKeysService.createKey({
      partnerId: inactivePartnerId,
      label: 'inactive-partner-key',
      scopes: ['pricelist'],
    });
    const res = await request(app.getHttpServer())
      .get('/partner/v1/pricelist?pickupCode=BHISA_CAWANG&destinationCode=EVISTA_HALIM')
      .set('Authorization', `Bearer ${rawKey}`)
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rate-limits the external API per key and returns the RATE_LIMITED envelope', async () => {
    const { rawKey } = await apiKeysService.createKey({
      partnerId,
      label: 'rate-key',
      scopes: ['pricelist'],
    });
    const auth = { Authorization: `Bearer ${rawKey}` };
    const url = '/partner/v1/pricelist?pickupCode=BHISA_CAWANG&destinationCode=EVISTA_HALIM';

    let limited: request.Response | undefined;
    // limit is 60/min; the 61st request in the window must be throttled
    for (let i = 0; i < 65; i++) {
      const res = await request(app.getHttpServer()).get(url).set(auth);
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).toBeDefined();
    expect(limited!.body.error.code).toBe('RATE_LIMITED');
  }, 30_000);

  it('applies security headers and a correlation id on every response', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeDefined();
  });
});
