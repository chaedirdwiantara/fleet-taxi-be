/**
 * Driver roster integration tests: the roster is SYNCED from fleet-monitoring
 * import data (Gojek + Grab) on GET /partner/portal/drivers; manual edits fill
 * in completeness and always win over re-syncs. Covers auto-sync, auto exit
 * detection ("Driver Keluar"), manual registration, filters, the PATCH
 * lifecycle (resign → deposit-return gate → un-resign reset), the home-survey
 * fields, name-conflict 409, documents, and cross-partner isolation.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq, inArray, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/db/database.service';
import { dropDetailPartition, ensureDetailPartition } from '../src/db/partitions';
import {
  drivers,
  fleetImports,
  grabImports,
  partnerPlates,
  partners,
  roles,
  userRoles,
  users,
} from '../src/db/schema';
import { fleetImportDetails, grabImportDetails } from '../src/db/schema/partitioned';
import { withDeadlockRetry } from './deadlock';

const RUN = `drv${Date.now()}`;
const PASSWORD = 'driver-test-pw';
const YEAR = 2034;
const MONTH = 2;
const PLATE_A = 'B 7301 DRA';
const PLATE_A_NORM = 'B7301DRA';
const PLATE_B = 'B 7302 DRB';
const PLATE_B_NORM = 'B7302DRB';

/** Fixture day inside the spec's own (YEAR, MONTH) period. */
const d = (day: number) =>
  `${YEAR}-${String(MONTH).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

// 1x1 JPEG — tiny but valid body for the dev upload sink
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

describe('partner driver roster (fleet sync)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let userAId: number;
  let userBId: number;
  let fleetImportId: number;
  let grabImportId: number;
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
        partnerId: p!.id,
      })
      .returning();
    await db.insert(userRoles).values({ userId: u!.id, roleId });
    return { partnerId: p!.id, userId: u!.id, email: u!.email };
  }

  /** presign → PUT (dev sink) → confirm; returns the documentId. */
  async function uploadDocument(
    agent: ReturnType<typeof request.agent>,
    driverId: number,
    kind: string,
  ): Promise<number> {
    const presign = await agent
      .post(`/partner/portal/drivers/documents/${driverId}/presign`)
      .send({ kind, contentType: 'image/jpeg', sizeBytes: JPG.length })
      .expect(201);
    const { documentId, uploadUrl } = presign.body.data as {
      documentId: number;
      uploadUrl: string;
    };
    expect(uploadUrl).toBe(`/partner/portal/drivers/documents/${documentId}/upload`);
    await agent.put(uploadUrl).set('Content-Type', 'image/jpeg').send(JPG).expect(200);
    const confirm = await agent
      .post(`/partner/portal/drivers/documents/${driverId}/${documentId}/confirm`)
      .expect(201);
    expect(confirm.body.data.status).toBe('uploaded');
    return documentId;
  }

  const listDrivers = async (agent: ReturnType<typeof request.agent>, query = '') => {
    const res = await agent.get(`/partner/portal/drivers${query}`).expect(200);
    return res.body as {
      data: Array<Record<string, unknown>>;
      meta: { total: number };
    };
  };

  const byName = (data: Array<Record<string, unknown>>) =>
    new Map(data.map((r) => [String(r.name).toUpperCase(), r]));

  /**
   * Newest gojek transaction date across the WHOLE table — the exit horizon the
   * sync compares against (global on purpose, like the Gojek grid). Specs share
   * one database, so a "still active" fixture has to sit exactly ON that date
   * rather than on a hard-coded one.
   */
  const gojekHorizon = async (): Promise<string> => {
    const rows = (await database.db.execute(
      sql`SELECT max(transaction_date)::text AS last FROM fleet_import_details`,
    )) as unknown as Array<{ last: string }>;
    return rows[0]!.last;
  };

  /** One extra gojek row on partner A's plate. `date` may sit outside the
   *  fixture month — the partition key is (period_year, period_month), not the
   *  transaction date, so it still lands in this spec's partition. */
  const addGojekRow = async (driverName: string, transactionDate: string) => {
    await database.db.insert(fleetImportDetails).values({
      importId: fleetImportId,
      periodYear: YEAR,
      periodMonth: MONTH,
      transactionDate,
      vehiclePlate: PLATE_A,
      vehiclePlateNorm: PLATE_A_NORM,
      driverName,
      amount: -100000,
      type: 'GoPay Deduction',
    });
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
    userAId = a.userId;
    userBId = b.userId;

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

    // Partner A operates PLATE_A; partner B operates PLATE_B.
    await agentA.post('/partner/portal/plates').send({ plateNumber: PLATE_A }).expect(201);
    await agentB.post('/partner/portal/plates').send({ plateNumber: PLATE_B }).expect(201);

    // Admin-imported fleet data the sync derives the roster from.
    await ensureDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
    const [imp] = await db
      .insert(fleetImports)
      .values({ filename: 'f.csv', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    fleetImportId = imp!.id;
    const fBase = { importId: fleetImportId, periodYear: YEAR, periodMonth: MONTH };
    await db.insert(fleetImportDetails).values([
      // "Budi  Santoso" (double space) — normalization collapses it.
      {
        ...fBase,
        transactionDate: d(3),
        vehiclePlate: PLATE_A,
        vehiclePlateNorm: PLATE_A_NORM,
        driverId: 'G-1',
        driverName: 'Budi  Santoso',
        amount: -300000,
        type: 'GoPay Deduction',
      },
      // duplicate rows for the same driver must not duplicate the roster row
      {
        ...fBase,
        transactionDate: d(4),
        vehiclePlate: PLATE_A,
        vehiclePlateNorm: PLATE_A_NORM,
        driverId: 'G-1',
        driverName: 'BUDI SANTOSO',
        amount: -300000,
        type: 'GoPay Deduction',
      },
      // driver on partner B's plate — must not appear for A
      {
        ...fBase,
        transactionDate: d(3),
        vehiclePlate: PLATE_B,
        vehiclePlateNorm: PLATE_B_NORM,
        driverId: 'G-2',
        driverName: 'Milik Sebelah',
        amount: -250000,
        type: 'GoPay Deduction',
      },
      // blank names are skipped
      {
        ...fBase,
        transactionDate: d(3),
        vehiclePlate: PLATE_A,
        vehiclePlateNorm: PLATE_A_NORM,
        driverName: '   ',
        amount: -100000,
        type: 'GoPay Deduction',
      },
    ]);

    await ensureDetailPartition(database, 'grab_import_details', YEAR, MONTH);
    const [gimp] = await db
      .insert(grabImports)
      .values({ filename: 'g.xlsx', periodMonth: MONTH, periodYear: YEAR, status: 'done' })
      .returning();
    grabImportId = gimp!.id;
    const gBase = { importId: grabImportId, periodYear: YEAR, periodMonth: MONTH };
    await db.insert(grabImportDetails).values([
      // grab-only driver → source grab, phone carried over
      {
        ...gBase,
        date: d(5),
        plateNumber: PLATE_A,
        plateNumberNorm: PLATE_A_NORM,
        driverName: 'Citra Lestari',
        driverPhoneNumber: '0812555666',
        city: 'Jakarta',
        totalRides: 6,
        compositeKey: `${PLATE_A_NORM}|Jakarta|Citra Lestari`,
      },
      // also on gojek (same normalized name) → gojek wins as source
      {
        ...gBase,
        date: d(6),
        plateNumber: PLATE_A,
        plateNumberNorm: PLATE_A_NORM,
        driverName: 'budi santoso',
        driverPhoneNumber: '0812999888',
        city: 'Jakarta',
        totalRides: 4,
        compositeKey: `${PLATE_A_NORM}|Jakarta|budi santoso`,
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await withDeadlockRetry(async () => {
      await db.delete(fleetImports).where(eq(fleetImports.id, fleetImportId));
      await db.delete(grabImports).where(eq(grabImports.id, grabImportId));
      await dropDetailPartition(database, 'fleet_import_details', YEAR, MONTH);
      await dropDetailPartition(database, 'grab_import_details', YEAR, MONTH);
      await db.delete(drivers).where(inArray(drivers.partnerId, [partnerAId, partnerBId]));
      await db
        .delete(partnerPlates)
        .where(inArray(partnerPlates.partnerId, [partnerAId, partnerBId]));
      await db.delete(users).where(inArray(users.id, [userAId, userBId]));
      await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    });
    await app.close();
  });

  let budiId: number;
  let citraId: number;

  it('GET /drivers auto-syncs the roster from the import data', async () => {
    const { data, meta } = await listDrivers(agentA);
    expect(meta.total).toBe(2);
    const byName = new Map(data.map((r) => [r.name, r]));

    const budi = byName.get('BUDI SANTOSO') ?? byName.get('Budi  Santoso');
    expect(budi).toBeDefined();
    expect(budi!.source).toBe('gojek'); // on both platforms — gojek wins
    expect(budi!.phone).toBe('0812999888'); // but grab contributes the phone
    expect(budi!.plateNumber).toBe(PLATE_A);
    expect(budi!.isActive).toBe(true);
    expect(budi!.resignedAt).toBeNull();
    expect(budi!.depositReturnStatus).toBe('none');
    expect(String(budi!.driverCode)).toMatch(/^DRV-\d{6}$/);
    expect(budi!.driverCode).toBe(`DRV-${String(budi!.id).padStart(6, '0')}`);
    budiId = budi!.id as number;

    const citra = byName.get('Citra Lestari');
    expect(citra).toBeDefined();
    expect(citra!.source).toBe('grab');
    expect(citra!.phone).toBe('0812555666');
    citraId = citra!.id as number;

    // partner B's driver never leaks into A's roster
    expect(byName.has('Milik Sebelah')).toBe(false);
  });

  it('scopes the sync per partner (cross-partner isolation)', async () => {
    const { data, meta } = await listDrivers(agentB);
    expect(meta.total).toBe(1);
    expect(data[0]!.name).toBe('Milik Sebelah');
    expect(data[0]!.source).toBe('gojek');

    // B cannot read or edit A's driver
    await agentB.get(`/partner/portal/drivers/${budiId}`).expect(404);
    await agentB.patch(`/partner/portal/drivers/${budiId}`).send({ phone: '0' }).expect(404);
  });

  it('is idempotent: re-listing does not duplicate rows', async () => {
    const { meta } = await listDrivers(agentA);
    expect(meta.total).toBe(2);
  });

  it('PATCH fills in completeness; manual edits win over re-syncs', async () => {
    const res = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({
        email: 'budi@test.example',
        phone: '0812000111',
        address: 'Jl. Melati 1',
        ktpNo: '3174000000000001',
        simNo: 'SIM-001',
        simExpired: '2027-03-15',
        bankAccount: 'BCA 123',
        depositAmount: 2_500_000,
      })
      .expect(200);
    expect(res.body.data).toMatchObject({
      email: 'budi@test.example',
      phone: '0812000111',
      depositAmount: 2_500_000,
    });

    // A re-sync (triggered by listing) must NOT overwrite the manual edits.
    const { data } = await listDrivers(agentA);
    const budi = data.find((r) => r.id === budiId)!;
    expect(budi.phone).toBe('0812000111');
    expect(budi.depositAmount).toBe(2_500_000);
  });

  it('validates the plate against the partner allowlist on PATCH', async () => {
    const bad = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ plateNumber: 'Z 9999 XX' })
      .expect(400);
    expect(bad.body.error.message).toBe('Plat tidak terdaftar untuk partner Anda');
    await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ plateNumber: PLATE_A })
      .expect(200);
  });

  it('rejects renaming a driver onto an existing name with 409', async () => {
    const res = await agentA
      .patch(`/partner/portal/drivers/${citraId}`)
      .send({ name: 'budi  SANTOSO' }) // normalizes to the same identity
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe('Nama driver sudah ada');
  });

  it('renaming updates the sync identity so the old name re-syncs as a new row', async () => {
    await agentA
      .patch(`/partner/portal/drivers/${citraId}`)
      .send({ name: 'Citra L. Baru' })
      .expect(200);
    const { data, meta } = await listDrivers(agentA);
    expect(meta.total).toBe(3); // "Citra Lestari" reappears from the import data
    const again = data.find((r) => r.name === 'Citra Lestari')!;
    expect(again).toBeDefined();
    expect(again.id).not.toBe(citraId);
  });

  // ---- auto exit detection ("Driver Keluar") ----------------------------------

  it('stamps exitedAt for a driver the import stopped carrying, and leaves current ones alone', async () => {
    await addGojekRow('Keluar Duluan', d(1));
    await addGojekRow('Masih Aktif', await gojekHorizon());

    const rows = byName((await listDrivers(agentA)).data);
    expect(rows.get('KELUAR DULUAN')!.exitedAt).toBe(d(1));
    expect(rows.get('KELUAR DULUAN')!.resignedAt).toBeNull(); // detection is not a manual resign
    expect(rows.get('MASIH AKTIF')!.exitedAt).toBeNull();

    // Detected exits are part of the resign list, and `auto` isolates them.
    const auto = await listDrivers(agentA, '?resigned=true&resignedType=auto');
    expect(auto.data.map((r) => r.name)).toContain('Keluar Duluan');
    expect(auto.data.map((r) => r.name)).not.toContain('Masih Aktif');
    expect(auto.data.every((r) => r.resignedAt === null)).toBe(true);

    // …and it does not leak into the "still on the roster" list.
    const onRoster = await listDrivers(agentA, '?resigned=false');
    expect(onRoster.data.map((r) => r.name)).toContain('Masih Aktif');
    expect(onRoster.data.map((r) => r.name)).not.toContain('Keluar Duluan');
  });

  it('clears exitedAt by itself once the driver shows up in the import again', async () => {
    await addGojekRow('Keluar Duluan', await gojekHorizon());
    const rows = byName((await listDrivers(agentA)).data);
    expect(rows.get('KELUAR DULUAN')!.exitedAt).toBeNull();

    const auto = await listDrivers(agentA, '?resigned=true&resignedType=auto');
    expect(auto.data.map((r) => r.name)).not.toContain('Keluar Duluan');
  });

  // ---- manual registration ------------------------------------------------------

  it('POST /drivers registers a driver by hand with a generated code', async () => {
    const res = await agentA
      .post('/partner/portal/drivers')
      .send({
        name: 'Manual Manuwara',
        phone: '0812777666',
        plateNumber: PLATE_A,
        address: 'Jl. Kenanga No. 9, Bogor',
        homeLat: -6.229728,
        homeLng: 106.689399,
      })
      .expect(201);
    const created = res.body.data as Record<string, unknown>;
    expect(created.source).toBe('manual');
    expect(created.driverCode).toBe(`DRV-${String(created.id).padStart(6, '0')}`);
    expect(created.isActive).toBe(true);
    expect(created.exitedAt).toBeNull(); // never auto-exited: the import doesn't know them
    expect(created.homeLat).toBe(-6.229728);
    expect(created.homeLng).toBe(106.689399);
    expect(created.documents).toEqual([]);

    // A re-sync must not touch or duplicate the hand-made row.
    const rows = byName((await listDrivers(agentA)).data);
    expect(rows.get('MANUAL MANUWARA')!.id).toBe(created.id);
    expect(rows.get('MANUAL MANUWARA')!.exitedAt).toBeNull();
  });

  it('rejects a manual registration that collides with an existing driver', async () => {
    const res = await agentA
      .post('/partner/portal/drivers')
      .send({ name: 'manual   MANUWARA' }) // normalizes to the same identity
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toBe('Nama driver sudah ada');
  });

  it('validates the manual registration payload', async () => {
    await agentA.post('/partner/portal/drivers').send({ name: '   ' }).expect(400);
    await agentA
      .post('/partner/portal/drivers')
      .send({ name: 'Plat Asing', plateNumber: 'Z 9999 XX' })
      .expect(400);
    // half a coordinate is never a valid pin
    const halfPin = await agentA
      .post('/partner/portal/drivers')
      .send({ name: 'Setengah Titik', homeLat: -6.2 })
      .expect(400);
    expect(halfPin.body.error.message).toBe(
      'Titik lokasi rumah harus berisi lintang dan bujur sekaligus',
    );
  });

  // ---- home survey ----------------------------------------------------------------

  it('stores the home-survey address, pin and photo on a synced driver', async () => {
    const saved = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ address: 'Jl. Survey No. 7', homeLat: -6.1751, homeLng: 106.865 })
      .expect(200);
    expect(saved.body.data).toMatchObject({
      address: 'Jl. Survey No. 7',
      homeLat: -6.1751,
      homeLng: 106.865,
    });

    await uploadDocument(agentA, budiId, 'home_survey');
    const detail = await agentA.get(`/partner/portal/drivers/${budiId}`).expect(200);
    const survey = (detail.body.data.documents as Array<{ kind: string; url?: string }>).filter(
      (doc) => doc.kind === 'home_survey',
    );
    expect(survey).toHaveLength(1);
    expect(survey[0]!.url).toBeTruthy();

    // Clearing the pin keeps the address (they are independent inputs).
    const cleared = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ homeLat: null, homeLng: null })
      .expect(200);
    expect(cleared.body.data.homeLat).toBeNull();
    expect(cleared.body.data.homeLng).toBeNull();
    expect(cleared.body.data.address).toBe('Jl. Survey No. 7');
  });

  it('gates depositReturned behind resignation and the uploaded proof', async () => {
    // not resigned yet
    const notResigned = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ depositReturned: true })
      .expect(400);
    expect(notResigned.body.error.message).toBe('Driver belum resign');

    // resign → resignedAt stamped, isActive forced false
    const resigned = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ resigned: true })
      .expect(200);
    expect(resigned.body.data.resignedAt).toBeTruthy();
    expect(resigned.body.data.isActive).toBe(false);
    const resignedAt = resigned.body.data.resignedAt as string;

    // resigning again keeps the original timestamp
    const again = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ resigned: true })
      .expect(200);
    expect(again.body.data.resignedAt).toBe(resignedAt);

    // deposit return requires the uploaded proof
    const noProof = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ depositReturned: true })
      .expect(400);
    expect(noProof.body.error.message).toBe('Unggah bukti pengembalian deposit terlebih dahulu');

    await uploadDocument(agentA, budiId, 'deposit_return_proof');
    const returned = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ depositReturned: true })
      .expect(200);
    expect(returned.body.data.depositReturnStatus).toBe('approved');
    expect(returned.body.data.depositReturnDecidedAt).toBeTruthy();

    // toggling back clears the decision
    const undone = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ depositReturned: false })
      .expect(200);
    expect(undone.body.data.depositReturnStatus).toBe('none');
    expect(undone.body.data.depositReturnDecidedAt).toBeNull();
    await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ depositReturned: true })
      .expect(200);
  });

  it('deleting the deposit-return proof resets the returned state', async () => {
    const detail = await agentA.get(`/partner/portal/drivers/${budiId}`).expect(200);
    const proof = (detail.body.data.documents as Array<{ id: number; kind: string }>).find(
      (doc) => doc.kind === 'deposit_return_proof',
    )!;
    await agentA.delete(`/partner/portal/drivers/documents/${budiId}/${proof.id}`).expect(200);
    const after = await agentA.get(`/partner/portal/drivers/${budiId}`).expect(200);
    expect(after.body.data.depositReturnStatus).toBe('none');
    expect(after.body.data.depositReturnDecidedAt).toBeNull();
  });

  it('filters: resigned / active / q / plate', async () => {
    // `resignedType=manual` isolates the partner's own decision from the
    // detected exits (which depend on the shared import horizon).
    const resigned = await listDrivers(agentA, '?resigned=true&resignedType=manual');
    expect(resigned.data.map((r) => r.id)).toEqual([budiId]);

    // The unnarrowed resign list is the union of both halves.
    const allOut = await listDrivers(agentA, '?resigned=true');
    expect(allOut.data.some((r) => r.id === budiId)).toBe(true);
    expect(allOut.data.every((r) => r.resignedAt !== null || r.exitedAt !== null)).toBe(true);

    const current = await listDrivers(agentA, '?resigned=false');
    expect(current.data.every((r) => r.resignedAt === null && r.exitedAt === null)).toBe(true);
    expect(current.data.some((r) => r.id === budiId)).toBe(false);
    expect(current.data.map((r) => r.name)).toContain('Masih Aktif');

    // Detection never flips the manual isActive flag — only a resign does.
    const inactive = await listDrivers(agentA, '?active=false');
    expect(inactive.data.map((r) => r.id)).toEqual([budiId]);

    const byName = await listDrivers(agentA, '?q=citra');
    expect(byName.data.length).toBeGreaterThanOrEqual(1);
    expect(byName.data.every((r) => String(r.name).toLowerCase().includes('citra'))).toBe(true);

    const byPlate = await listDrivers(agentA, `?plate=${PLATE_A_NORM}`);
    expect(byPlate.data.some((r) => r.id === budiId)).toBe(true);
  });

  it('un-resigning clears resignedAt and resets the deposit-return state', async () => {
    const res = await agentA
      .patch(`/partner/portal/drivers/${budiId}`)
      .send({ resigned: false, isActive: true })
      .expect(200);
    expect(res.body.data.resignedAt).toBeNull();
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.depositReturnStatus).toBe('none');
    expect(res.body.data.depositReturnDecidedAt).toBeNull();
  });

  it('documents upload/replace still works from the edit page (ktp)', async () => {
    const first = await uploadDocument(agentA, budiId, 'ktp');
    const second = await uploadDocument(agentA, budiId, 'ktp'); // replaces the first
    const detail = await agentA.get(`/partner/portal/drivers/${budiId}`).expect(200);
    const ktp = (detail.body.data.documents as Array<{ id: number; kind: string }>).filter(
      (doc) => doc.kind === 'ktp',
    );
    expect(ktp.map((doc) => doc.id)).toEqual([second]);
    expect(first).not.toBe(second);
  });

  it('exposes no delete/resign endpoints for drivers', async () => {
    await agentA.delete(`/partner/portal/drivers/${budiId}`).expect(404);
    await agentA.post(`/partner/portal/drivers/${budiId}/resign`).expect(404);
    await agentA.get('/partner/portal/driver-registrations').expect(404);
    await agentA.get('/partner/portal/driver-resignations').expect(404);
  });
});
