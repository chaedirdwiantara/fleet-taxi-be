/**
 * Integration tests — need the docker-compose Postgres + Redis running and
 * migrations applied (pnpm db:migrate).
 */
import { Controller, Get, INestApplication, Req, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ApiKeyGuard } from '../src/common/guards/api-key.guard';
import { DatabaseService } from '../src/db/database.service';
import { partners, roles, userRoles, users } from '../src/db/schema';
import { ApiKeysService } from '../src/partners/api-keys.service';
import { PartnersModule } from '../src/partners/partners.module';

const RUN = `e2e${Date.now()}`;
const ADMIN_EMAIL = `${RUN}-admin@test.example`;
const PASSWORD = 'test-password-123';

@Controller('test-partner-api')
class PartnerApiFixtureController {
  @Get('whoami')
  @UseGuards(ApiKeyGuard)
  whoami(@Req() req: Request): { code: string; scopes: string[] } {
    return { code: req.partner!.code, scopes: req.partner!.scopes };
  }
}

describe('auth (M1 deliverable)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let rawApiKey: string;
  let seededUserIds: number[] = [];
  let seededPartnerId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, PartnersModule],
      controllers: [PartnerApiFixtureController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    database = app.get(DatabaseService);
    const { db } = database;

    await db
      .insert(roles)
      .values([{ name: 'admin' }, { name: 'partner' }])
      .onConflictDoNothing();
    const roleRows = await db
      .select()
      .from(roles)
      .where(inArray(roles.name, ['admin', 'partner']));
    const adminRoleId = roleRows.find((r) => r.name === 'admin')!.id;

    const [admin] = await db
      .insert(users)
      .values({
        email: ADMIN_EMAIL,
        passwordHash: await argon2.hash(PASSWORD),
        fullName: 'E2E Admin',
      })
      .returning();
    await db.insert(userRoles).values({ userId: admin!.id, roleId: adminRoleId });
    seededUserIds = [admin!.id];

    const [partner] = await db
      .insert(partners)
      .values({ code: `${RUN}-PARTNER`, name: 'E2E Partner', type: 'shuttle' })
      .returning();
    seededPartnerId = partner!.id;

    const apiKeysService = app.get(ApiKeysService);
    rawApiKey = (
      await apiKeysService.createKey({
        partnerId: partner!.id,
        label: 'e2e',
        scopes: ['order:read'],
      })
    ).rawKey;
  });

  afterAll(async () => {
    const { db } = database;
    await db.delete(users).where(inArray(users.id, seededUserIds));
    await db.delete(partners).where(eq(partners.id, seededPartnerId)); // cascades api_keys
    await app.close();
  });

  it('rejects a wrong password with UNAUTHENTICATED envelope', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong' })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('logs in, reads /auth/me with the cookie, then logs out', async () => {
    const agent = request.agent(app.getHttpServer());

    const login = await agent
      .post('/auth/login')
      .send({ email: ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
    expect(login.body.data.email).toBe(ADMIN_EMAIL);
    expect(login.body.data.roles).toContain('admin');
    expect(login.headers['set-cookie']?.[0]).toMatch(/^sid=/);

    const me = await agent.get('/auth/me').expect(200);
    expect(me.body.data.email).toBe(ADMIN_EMAIL);

    await agent.post('/auth/logout').expect(200);
    const after = await agent.get('/auth/me').expect(401);
    expect(after.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('blocks /auth/me without a session', async () => {
    const res = await request(app.getHttpServer()).get('/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('authenticates the external surface with a hashed API key', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-partner-api/whoami')
      .set('Authorization', `Bearer ${rawApiKey}`)
      .expect(200);
    expect(res.body.data.code).toBe(`${RUN}-PARTNER`);
    expect(res.body.data.scopes).toContain('order:read');
  });

  it('rejects missing/invalid/revoked API keys', async () => {
    await request(app.getHttpServer()).get('/test-partner-api/whoami').expect(401);

    await request(app.getHttpServer())
      .get('/test-partner-api/whoami')
      .set('Authorization', 'Bearer ftk_definitely-not-a-real-key-000000000000')
      .expect(401);

    const apiKeysService = app.get(ApiKeysService);
    const { rawKey, id } = await apiKeysService.createKey({
      partnerId: seededPartnerId,
      label: 'to-revoke',
    });
    await apiKeysService.revokeKey(id);
    const res = await request(app.getHttpServer())
      .get('/test-partner-api/whoami')
      .set('Authorization', `Bearer ${rawKey}`)
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
