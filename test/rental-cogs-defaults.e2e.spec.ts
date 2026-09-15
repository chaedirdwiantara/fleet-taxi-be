/**
 * Per-partner COGS presets ("Setting COGS"): lazy seed on first read, delete
 * one preset, last-preset protection (an empty table would re-seed the legacy
 * defaults on the next read), and cross-partner isolation.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { partners, rentalCogsDefaults, roles, userRoles, users } from '../src/db/schema';

const RUN = `cogs${Date.now()}`;
const PASSWORD = 'cogs-defaults-test-pw';

type Preset = { key: string; label: string; cogsPerDay: number };

describe('rental COGS defaults', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let agentA: ReturnType<typeof request.agent>;
  let agentB: ReturnType<typeof request.agent>;

  async function makePartnerUser(code: string, roleId: number) {
    const { db } = database;
    const [p] = await db
      .insert(partners)
      .values({ code, name: `Partner ${code}`, type: 'shuttle' })
      .returning();
    const [u] = await db
      .insert(users)
      .values({
        email: `${code.toLowerCase()}@test.example`,
        passwordHash: await argon2.hash(PASSWORD),
        fullName: `User ${code}`,
        partnerId: p!.id,
      })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId });
    return { partnerId: p!.id, email: u!.email };
  }

  const listOf = async (agent: ReturnType<typeof request.agent>): Promise<Preset[]> => {
    const res = await agent.get('/partner/portal/rentals/cogs-defaults').expect(200);
    return res.body.data.items as Preset[];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    database = app.get(DatabaseService);
    const { db } = database;

    await db
      .insert(roles)
      .values([{ name: 'partner' }])
      .onConflictDoNothing();
    const [partnerRole] = await db.select().from(roles).where(eq(roles.name, 'partner'));

    const a = await makePartnerUser(`${RUN}-A`, partnerRole!.id);
    const b = await makePartnerUser(`${RUN}-B`, partnerRole!.id);
    partnerAId = a.partnerId;
    partnerBId = b.partnerId;

    agentA = request.agent(app.getHttpServer());
    agentB = request.agent(app.getHttpServer());
    await agentA
      .post('/partner/portal/login')
      .send({ email: a.email, password: PASSWORD })
      .expect(200);
    await agentB
      .post('/partner/portal/login')
      .send({ email: b.email, password: PASSWORD })
      .expect(200);
  });

  afterAll(async () => {
    const { db } = database;
    const ids = [partnerAId, partnerBId];
    await db.delete(rentalCogsDefaults).where(inArray(rentalCogsDefaults.partnerId, ids));
    await db.delete(users).where(inArray(users.partnerId, ids));
    await db.delete(partners).where(inArray(partners.id, ids));
    await app.close();
  });

  it('deletes one preset and leaves the others untouched', async () => {
    const before = await listOf(agentA);
    expect(before.length).toBeGreaterThan(1); // lazy-seeded legacy defaults
    const victim = before[0]!;

    const res = await agentA
      .delete(`/partner/portal/rentals/cogs-defaults/${victim.key}`)
      .expect(200);
    expect(res.body).toEqual({ success: true, data: { deleted: true } });

    const after = await listOf(agentA);
    expect(after.map((p) => p.key)).toEqual(before.slice(1).map((p) => p.key));
  });

  it('returns 404 for an unknown key', async () => {
    const res = await agentA.delete('/partner/portal/rentals/cogs-defaults/tidak-ada').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it("does not let a partner delete another partner's preset", async () => {
    const [ownB] = await listOf(agentB);
    const res = await agentA
      .delete(`/partner/portal/rentals/cogs-defaults/${ownB!.key}`)
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await listOf(agentB)).some((p) => p.key === ownB!.key)).toBe(true);
  });

  it('refuses to delete the last remaining preset', async () => {
    let remaining = await listOf(agentA);
    while (remaining.length > 1) {
      await agentA.delete(`/partner/portal/rentals/cogs-defaults/${remaining[0]!.key}`).expect(200);
      remaining = await listOf(agentA);
    }
    const [last] = remaining;

    const res = await agentA
      .delete(`/partner/portal/rentals/cogs-defaults/${last!.key}`)
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(await listOf(agentA)).toEqual([last]);
  });
});
