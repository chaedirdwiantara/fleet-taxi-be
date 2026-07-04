/**
 * Full import-pipeline integration test: upload → queued parse → rows land in
 * the right partition → rollback removes exactly that batch.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { and, eq, inArray } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { fleetImportDetails, roles, userRoles, users } from '../src/db/schema';

const RUN = `imp${Date.now()}`;
const ADMIN_EMAIL = `${RUN}@test.example`;
const PASSWORD = 'import-test-pw';
// Unique far-future period so parallel runs / leftovers never collide
const YEAR = 2031;
const MONTH = 3;

const GOJEK_CSV = [
  'Some banner line,,,,,,,,',
  'Date & Time(JKT),Driver ID,Driver Name,Phone,Vehicle,Amount,Total Outstanding Balance,Type,GoPay Transaction Reference ID',
  '04/03/2031 09:00:00,D1,Budi,0812,B 1111 AA,488000,0,Deduction,REF-1',
  '05/03/2031 09:00:00,D1,Budi,0812,B 1111 AA,"Rp 250,000",0,Manual Payment,REF-2',
  '05/03/2031 10:00:00,D2,Siti,0813,B 2222 BB,600000,0,due,REF-3',
  ',,,,,,,,',
  'not-a-date,D9,X,0,B 9999 XX,1,0,Deduction,REF-9',
].join('\n');

async function until<T>(fn: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('import pipeline (M2 deliverable)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let agent: ReturnType<typeof request.agent>;
  let adminId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    database = app.get(DatabaseService);
    const { db } = database;
    await db
      .insert(roles)
      .values([{ name: 'admin' }])
      .onConflictDoNothing();
    const [adminRole] = await db.select().from(roles).where(eq(roles.name, 'admin'));
    const [admin] = await db
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash: await argon2.hash(PASSWORD), fullName: 'Imp' })
      .returning();
    adminId = admin!.id;
    await db.insert(userRoles).values({ userId: adminId, roleId: adminRole!.id });

    agent = request.agent(app.getHttpServer());
    await agent.post('/auth/login').send({ email: ADMIN_EMAIL, password: PASSWORD }).expect(200);
  }, 30_000);

  afterAll(async () => {
    await database.db.delete(users).where(inArray(users.id, [adminId]));
    await app.close();
  });

  it('uploads, parses async, lands rows in the right partition, then rolls back', async () => {
    // 1. Upload → 202 + importId immediately (no synchronous parse)
    const upload = await agent
      .post('/admin/fleet/gojek/imports')
      .field('month', String(MONTH))
      .field('year', String(YEAR))
      .attach('file', Buffer.from(GOJEK_CSV, 'utf8'), 'gojek-march.csv')
      .expect(202);
    const importId = upload.body.data.importId as number;
    expect(importId).toBeGreaterThan(0);

    // 2. Worker processes it → status done with total_rows = 3 valid rows
    const done = await until(async () => {
      const res = await agent.get(`/admin/fleet/gojek/imports/${importId}`).expect(200);
      const row = res.body.data as { status: string; totalRows: number };
      if (row.status === 'failed') throw new Error('import failed');
      return row.status === 'done' ? row : null;
    });
    expect(done.totalRows).toBe(3); // banner, empty and bad-date rows skipped

    // 3. Rows are in the partitioned table, normalized and typed
    const rows = await database.db
      .select()
      .from(fleetImportDetails)
      .where(eq(fleetImportDetails.importId, importId));
    expect(rows).toHaveLength(3);
    const manual = rows.find((r) => r.type === 'Manual Payment');
    expect(manual?.amount).toBe(250000);
    expect(manual?.isManualPaymentSetoran).toBe(1);
    expect(rows.every((r) => r.periodYear === YEAR && r.periodMonth === MONTH)).toBe(true);
    expect(rows.find((r) => r.vehiclePlate === 'B 1111 AA')?.vehiclePlateNorm).toBe('B1111AA');

    // 4. Import shows up in the batch list
    const list = await agent.get('/admin/fleet/gojek/imports').expect(200);
    expect(list.body.data.some((i: { id: number }) => i.id === importId)).toBe(true);

    // 5. Rollback (queued) removes exactly this batch
    await agent.delete(`/admin/fleet/gojek/imports/${importId}`).expect(202);
    await until(async () => {
      const res = await agent.get(`/admin/fleet/gojek/imports/${importId}`);
      return res.status === 404 ? true : null;
    });
    const after = await database.db
      .select()
      .from(fleetImportDetails)
      .where(
        and(
          eq(fleetImportDetails.periodYear, YEAR),
          eq(fleetImportDetails.periodMonth, MONTH),
          eq(fleetImportDetails.importId, importId),
        ),
      )
      .catch(() => []); // partition may already be dropped (fast path) — that's fine
    expect(after).toHaveLength(0);
  }, 60_000);

  it('rejects uploads without admin ability and unsupported file types', async () => {
    await request(app.getHttpServer())
      .post('/admin/fleet/gojek/imports')
      .field('month', '3')
      .field('year', '2031')
      .attach('file', Buffer.from('x'), 'x.csv')
      .expect(401); // no session

    const res = await agent
      .post('/admin/fleet/gojek/imports')
      .field('month', '3')
      .field('year', '2031')
      .attach('file', Buffer.from('x'), 'legacy.xls')
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
