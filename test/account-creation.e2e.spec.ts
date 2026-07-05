/**
 * Integration tests for admin-driven account creation (super_admin only).
 * Needs the docker-compose Postgres + Redis running and migrations applied
 * (pnpm db:migrate).
 */
import { Controller, Get, INestApplication, Req, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq, inArray, like } from 'drizzle-orm';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { ApiKeyGuard } from '../src/common/guards/api-key.guard';
import { DatabaseService } from '../src/db/database.service';
import { partners, roles, userRoles, users } from '../src/db/schema';
import { PartnersModule } from '../src/partners/partners.module';

const RUN = `acct${Date.now()}`;
const SUPER_EMAIL = `${RUN}-super@test.example`;
const PLAIN_ADMIN_EMAIL = `${RUN}-admin@test.example`;
const PASSWORD = 'test-password-123';

// Emails/codes created through the API during the run (for assertions).
const NEW_ADMIN_EMAIL = `${RUN}-newadmin@test.example`;
const NEW_FINANCE_EMAIL = `${RUN}-finance@test.example`;
const PORTAL_EMAIL = `${RUN}-portal@test.example`;
const PARTNER_CODE = `${RUN}PARTNER`.toUpperCase();

@Controller('test-partner-api')
class PartnerApiFixtureController {
  @Get('whoami')
  @UseGuards(ApiKeyGuard)
  whoami(@Req() req: Request): { code: string; scopes: string[] } {
    return { code: req.partner!.code, scopes: req.partner!.scopes };
  }
}

describe('account creation (super_admin only)', () => {
  let app: INestApplication;
  let database: DatabaseService;

  // authenticated cookie agents
  let superAgent: request.SuperAgentTest;
  let adminAgent: request.SuperAgentTest;

  let createdPartnerId: number;

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
      .values([
        { name: 'super_admin' },
        { name: 'admin' },
        { name: 'partner' },
        { name: 'finance' },
      ])
      .onConflictDoNothing();
    const roleRows = await db
      .select()
      .from(roles)
      .where(inArray(roles.name, ['super_admin', 'admin']));
    const superRoleId = roleRows.find((r) => r.name === 'super_admin')!.id;
    const adminRoleId = roleRows.find((r) => r.name === 'admin')!.id;

    const [superUser] = await db
      .insert(users)
      .values({
        email: SUPER_EMAIL,
        passwordHash: await argon2.hash(PASSWORD),
        fullName: 'E2E Super Admin',
      })
      .returning();
    await db.insert(userRoles).values({ userId: superUser!.id, roleId: superRoleId });

    const [plainAdmin] = await db
      .insert(users)
      .values({
        email: PLAIN_ADMIN_EMAIL,
        passwordHash: await argon2.hash(PASSWORD),
        fullName: 'E2E Plain Admin',
      })
      .returning();
    await db.insert(userRoles).values({ userId: plainAdmin!.id, roleId: adminRoleId });

    superAgent = request.agent(app.getHttpServer());
    await superAgent
      .post('/admin/auth/login')
      .send({ email: SUPER_EMAIL, password: PASSWORD })
      .expect(200);

    adminAgent = request.agent(app.getHttpServer());
    await adminAgent
      .post('/admin/auth/login')
      .send({ email: PLAIN_ADMIN_EMAIL, password: PASSWORD })
      .expect(200);
  });

  afterAll(async () => {
    const { db } = database;
    // users reference partners, so delete users first; user_roles + api_keys cascade.
    await db.delete(users).where(like(users.email, `${RUN}%`));
    if (createdPartnerId) await db.delete(partners).where(eq(partners.id, createdPartnerId));
    await app.close();
  });

  // ---- authorization -----------------------------------------------------

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app.getHttpServer()).get('/admin/users').expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('forbids a plain admin (non super_admin) from every user-management endpoint (403)', async () => {
    await adminAgent
      .post('/admin/users')
      .send({ email: 'x@test.example', fullName: 'X', password: 'password123', roles: ['admin'] })
      .expect(403)
      .expect((r) => expect(r.body.error.code).toBe('FORBIDDEN'));
    await adminAgent.get('/admin/users').expect(403);
    await adminAgent.post('/admin/partners').send({ code: 'X', name: 'X' }).expect(403);
    await adminAgent.get('/admin/partners').expect(403);
    await adminAgent
      .post('/admin/partners/1/users')
      .send({ email: 'x@test.example', fullName: 'X', password: 'password123' })
      .expect(403);
    await adminAgent.post('/admin/partners/1/api-keys').send({}).expect(403);
  });

  // ---- admin/staff user creation ----------------------------------------

  it('lets a super_admin create an admin/staff user with mustChangePassword=true and no hash', async () => {
    const res = await superAgent
      .post('/admin/users')
      .send({
        email: NEW_ADMIN_EMAIL,
        fullName: 'New Admin',
        password: 'password123',
        roles: ['admin'],
      })
      .expect(201);
    expect(res.body.data.email).toBe(NEW_ADMIN_EMAIL);
    expect(res.body.data.roles).toEqual(['admin']);
    expect(res.body.data.mustChangePassword).toBe(true);
    expect(res.body.data.partner).toBeNull();
    expect(res.body.data.passwordHash).toBeUndefined();
  });

  it('creates a finance user (role subset) too', async () => {
    const res = await superAgent
      .post('/admin/users')
      .send({
        email: NEW_FINANCE_EMAIL,
        fullName: 'New Finance',
        password: 'password123',
        roles: ['finance'],
      })
      .expect(201);
    expect(res.body.data.roles).toEqual(['finance']);
  });

  it('rejects a weak (<8 char) password with a validation error', async () => {
    const res = await superAgent
      .post('/admin/users')
      .send({
        email: `${RUN}-weak@test.example`,
        fullName: 'Weak',
        password: 'short',
        roles: ['admin'],
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 CONFLICT on a duplicate email', async () => {
    const res = await superAgent
      .post('/admin/users')
      .send({ email: NEW_ADMIN_EMAIL, fullName: 'Dup', password: 'password123', roles: ['admin'] })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('lets the freshly-created admin log in at /admin/auth/login with mustChangePassword surfaced', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: NEW_ADMIN_EMAIL, password: 'password123' })
      .expect(200);
    expect(res.body.data.mustChangePassword).toBe(true);
  });

  it('lists admin/staff users (type=admin) including roles + mustChangePassword', async () => {
    const res = await superAgent.get('/admin/users?type=admin').expect(200);
    expect(res.body.meta).toMatchObject({ page: 1, pageSize: 50 });
    const row = res.body.data.find((u: { email: string }) => u.email === NEW_ADMIN_EMAIL);
    expect(row).toBeDefined();
    expect(row.roles).toEqual(['admin']);
    expect(row.mustChangePassword).toBe(true);
    expect(row.partner).toBeNull();
    expect(row).toHaveProperty('createdAt');
    // admin list must not contain partner-portal users
    expect(res.body.data.every((u: { partner: unknown }) => u.partner === null)).toBe(true);
  });

  // ---- first-login change-password --------------------------------------

  it('forces first-login change-password: verifies current, clears the flag, and rotates the password', async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/admin/auth/login')
      .send({ email: NEW_ADMIN_EMAIL, password: 'password123' })
      .expect(200);

    // wrong current password → 401
    await agent
      .post('/auth/change-password')
      .send({ currentPassword: 'not-it', newPassword: 'brand-new-password' })
      .expect(401);

    // correct current password → 200 and flag cleared
    const changed = await agent
      .post('/auth/change-password')
      .send({ currentPassword: 'password123', newPassword: 'brand-new-password' })
      .expect(200);
    expect(changed.body.data.mustChangePassword).toBe(false);

    // me now reflects the cleared flag on the same session
    const me = await agent.get('/admin/auth/me').expect(200);
    expect(me.body.data.mustChangePassword).toBe(false);

    // old password no longer works; new one does and no longer forces a change
    await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: NEW_ADMIN_EMAIL, password: 'password123' })
      .expect(401);
    const relogin = await request(app.getHttpServer())
      .post('/admin/auth/login')
      .send({ email: NEW_ADMIN_EMAIL, password: 'brand-new-password' })
      .expect(200);
    expect(relogin.body.data.mustChangePassword).toBe(false);
  });

  // ---- partner + portal user + api key ----------------------------------

  it('lets a super_admin create a partner (409 on duplicate code)', async () => {
    const res = await superAgent
      .post('/admin/partners')
      .send({ code: PARTNER_CODE, name: 'E2E Partner', type: 'shuttle' })
      .expect(201);
    createdPartnerId = res.body.data.id;
    expect(res.body.data.code).toBe(PARTNER_CODE);

    const dup = await superAgent
      .post('/admin/partners')
      .send({ code: PARTNER_CODE.toLowerCase(), name: 'Dup' })
      .expect(409);
    expect(dup.body.error.code).toBe('CONFLICT');
  });

  it('lists partners for the picker', async () => {
    const res = await superAgent.get('/admin/partners').expect(200);
    expect(res.body.data.some((p: { id: number }) => p.id === createdPartnerId)).toBe(true);
  });

  it('creates a partner-portal user that can log in at /partner/portal/login', async () => {
    const created = await superAgent
      .post(`/admin/partners/${createdPartnerId}/users`)
      .send({ email: PORTAL_EMAIL, fullName: 'Portal User', password: 'password123' })
      .expect(201);
    expect(created.body.data.roles).toEqual(['partner']);
    expect(created.body.data.partner).toMatchObject({ id: createdPartnerId, code: PARTNER_CODE });
    expect(created.body.data.mustChangePassword).toBe(true);

    const login = await request(app.getHttpServer())
      .post('/partner/portal/login')
      .send({ email: PORTAL_EMAIL, password: 'password123' })
      .expect(200);
    expect(login.body.data.roles).toContain('partner');
    expect(login.body.data.partnerId).toBe(createdPartnerId);
    expect(login.body.data.mustChangePassword).toBe(true);
  });

  it('404s when creating a portal user under a non-existent partner', async () => {
    await superAgent
      .post('/admin/partners/99999999/users')
      .send({ email: `${RUN}-nope@test.example`, fullName: 'Nope', password: 'password123' })
      .expect(404);
  });

  it('lists partner-portal users (type=partner) with the linked partner', async () => {
    const res = await superAgent.get('/admin/users?type=partner').expect(200);
    const row = res.body.data.find((u: { email: string }) => u.email === PORTAL_EMAIL);
    expect(row).toBeDefined();
    expect(row.roles).toEqual(['partner']);
    expect(row.partner).toMatchObject({
      id: createdPartnerId,
      code: PARTNER_CODE,
      type: 'shuttle',
    });
    // partner list must not contain admin/staff users
    expect(res.body.data.every((u: { partner: unknown }) => u.partner !== null)).toBe(true);
  });

  it('generates an API key (rawKey once) that authenticates the external /partner/v1 surface', async () => {
    const res = await superAgent
      .post(`/admin/partners/${createdPartnerId}/api-keys`)
      .send({ label: 'e2e key', scopes: ['order:read'], rateLimit: 60 })
      .expect(201);
    const rawKey = res.body.data.rawKey as string;
    expect(rawKey).toMatch(/^ftk_/);
    expect(res.body.data.keyPrefix).toBeDefined();

    const whoami = await request(app.getHttpServer())
      .get('/test-partner-api/whoami')
      .set('Authorization', `Bearer ${rawKey}`)
      .expect(200);
    expect(whoami.body.data.code).toBe(PARTNER_CODE);
    expect(whoami.body.data.scopes).toContain('order:read');
  });
});
