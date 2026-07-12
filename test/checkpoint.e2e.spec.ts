/**
 * Checkpoint (vehicle-handover inspection) integration tests: plate-allowlist
 * gating, the draft → photos → signatures → complete lifecycle, cross-partner
 * isolation, comparison pairing, and the dev upload-sink/media/PDF endpoints.
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
import { checkpoints, partnerPlates, partners, roles, userRoles, users } from '../src/db/schema';

const RUN = `cpt${Date.now()}`;
const PASSWORD = 'checkpoint-test-pw';
const PLATE = `B ${String(Date.now()).slice(-4)} CPT`;

// 1x1 PNG / JPEG fixtures — tiny but valid image bodies for the upload sink
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

describe('partner checkpoints (handover inspection)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let partnerAId: number;
  let partnerBId: number;
  let userAId: number;
  let userBId: number;
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

  /** Runs presign → PUT (dev sink) → confirm and returns the mediaId. */
  async function uploadMedia(
    agent: ReturnType<typeof request.agent>,
    checkpointId: number,
    body: { kind: string; pointKey?: string; contentType: string },
    bytes: Buffer,
  ): Promise<number> {
    const presign = await agent
      .post(`/partner/portal/checkpoints/${checkpointId}/media/presign`)
      .send({ ...body, sizeBytes: bytes.length })
      .expect(201);
    const { mediaId, uploadUrl } = presign.body.data as { mediaId: number; uploadUrl: string };
    expect(uploadUrl).toBe(`/partner/portal/checkpoints/media/${mediaId}/upload`);
    await agent.put(uploadUrl).set('Content-Type', body.contentType).send(bytes).expect(200);
    const confirm = await agent
      .post(`/partner/portal/checkpoints/${checkpointId}/media/${mediaId}/confirm`)
      .expect(201);
    expect(confirm.body.data.status).toBe('uploaded');
    return mediaId;
  }

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

    // Partner A registers the plate; partner B does not.
    await agentA.post('/partner/portal/plates').send({ plateNumber: PLATE }).expect(201);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db.delete(checkpoints).where(inArray(checkpoints.partnerId, [partnerAId, partnerBId]));
    await db
      .delete(partnerPlates)
      .where(inArray(partnerPlates.partnerId, [partnerAId, partnerBId]));
    await db.delete(users).where(inArray(users.id, [userAId, userBId]));
    await db.delete(partners).where(inArray(partners.id, [partnerAId, partnerBId]));
    await app.close();
  });

  it('rejects a checkpoint for an unregistered plate', async () => {
    const res = await agentA
      .post('/partner/portal/checkpoints')
      .send({ plateNumber: 'Z 9999 XX', handoverType: 'delivery_to_customer' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  let deliveryId: number;

  it('creates a draft with the 10 template points seeded', async () => {
    const res = await agentA
      .post('/partner/portal/checkpoints')
      .send({
        plateNumber: PLATE,
        handoverType: 'delivery_to_customer',
        counterpartName: 'Budi',
      })
      .expect(201);
    const detail = res.body.data;
    deliveryId = detail.id;
    expect(detail.status).toBe('draft');
    expect(detail.points).toHaveLength(10);
    expect(detail.points[0].pointKey).toBe('exterior_front');
    expect(detail.points.every((p: { passed: null }) => p.passed === null)).toBe(true);
  });

  it('is invisible to another partner (404, not 403)', async () => {
    await agentB.get(`/partner/portal/checkpoints/${deliveryId}`).expect(404);
    await agentB
      .patch(`/partner/portal/checkpoints/${deliveryId}/points/exterior_front`)
      .send({ passed: true })
      .expect(404);
  });

  it('refuses completion while points/photos/signatures are missing', async () => {
    const res = await agentA
      .post(`/partner/portal/checkpoints/${deliveryId}/complete`)
      .send({ odometerKm: 1500, batteryPercent: 90 })
      .expect(400);
    const details = res.body.error.details as Array<{ field: string; message: string }>;
    // 10 unassessed + 10 photoless + 2 signatures
    expect(details).toHaveLength(22);
    expect(details.some((d) => d.field === 'signature_partner')).toBe(true);
  });

  it('walks the full draft lifecycle: points, photos, signatures, complete', async () => {
    for (const key of [
      'exterior_front',
      'exterior_rear',
      'exterior_left',
      'exterior_right',
      'interior_front',
      'interior_rear',
      'dashboard_odometer',
      'tires_wheels',
      'charging_port',
      'keys_documents',
    ]) {
      await agentA
        .patch(`/partner/portal/checkpoints/${deliveryId}/points/${key}`)
        .send({
          passed: key !== 'tires_wheels',
          note: key === 'tires_wheels' ? 'Ban aus' : undefined,
        })
        .expect(200);
      await uploadMedia(
        agentA,
        deliveryId,
        { kind: 'photo', pointKey: key, contentType: 'image/jpeg' },
        JPG,
      );
    }
    await uploadMedia(
      agentA,
      deliveryId,
      { kind: 'signature_partner', contentType: 'image/png' },
      PNG,
    );
    await uploadMedia(
      agentA,
      deliveryId,
      { kind: 'signature_counterpart', contentType: 'image/png' },
      PNG,
    );

    const res = await agentA
      .post(`/partner/portal/checkpoints/${deliveryId}/complete`)
      .send({ odometerKm: 1500, batteryPercent: 90, generalNotes: 'OK' })
      .expect(201);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.completedAt).toBeTruthy();
  });

  it('locks a completed checkpoint against edits (409)', async () => {
    await agentA
      .patch(`/partner/portal/checkpoints/${deliveryId}/points/exterior_front`)
      .send({ passed: false })
      .expect(409);
    await agentA
      .patch(`/partner/portal/checkpoints/${deliveryId}`)
      .send({ generalNotes: 'x' })
      .expect(409);
  });

  it('streams uploaded media back with the right content type', async () => {
    const detail = await agentA.get(`/partner/portal/checkpoints/${deliveryId}`).expect(200);
    const photo = detail.body.data.points[0].media[0];
    const file = await agentA.get(photo.url).expect(200);
    expect(file.headers['content-type']).toContain('image/jpeg');
  });

  it('serves the berita acara PDF for a completed checkpoint', async () => {
    const res = await agentA
      .get(`/partner/portal/checkpoints/${deliveryId}/pdf`)
      .buffer()
      .expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('pairs a return checkpoint with the latest completed delivery', async () => {
    const created = await agentA
      .post('/partner/portal/checkpoints')
      .send({ plateNumber: PLATE, handoverType: 'return_from_customer' })
      .expect(201);
    const returnId = created.body.data.id as number;

    const cmp = await agentA.get(`/partner/portal/checkpoints/${returnId}/comparison`).expect(200);
    expect(cmp.body.data.id).toBe(deliveryId);
    expect(cmp.body.data.handoverType).toBe('delivery_to_customer');

    // A delivery checkpoint has nothing to compare against
    const cmpDelivery = await agentA
      .get(`/partner/portal/checkpoints/${deliveryId}/comparison`)
      .expect(200);
    expect(cmpDelivery.body.data).toBeNull();
  });

  it('lists checkpoints with filters and pagination meta', async () => {
    const res = await agentA
      .get('/partner/portal/checkpoints')
      .query({ status: 'completed', plate: PLATE })
      .expect(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].id).toBe(deliveryId);
    expect(res.body.data[0].photoCount).toBe(10);

    // Partial plate search: a middle fragment of the plate still matches
    const partial = await agentA
      .get('/partner/portal/checkpoints')
      .query({ plate: PLATE.split(' ')[1] })
      .expect(200);
    expect(partial.body.meta.total).toBeGreaterThanOrEqual(1);

    const none = await agentB.get('/partner/portal/checkpoints').expect(200);
    expect(none.body.meta.total).toBe(0);
  });

  it('deletes a draft (with its media) but never a completed checkpoint', async () => {
    const created = await agentA
      .post('/partner/portal/checkpoints')
      .send({ plateNumber: PLATE, handoverType: 'delivery_to_driver' })
      .expect(201);
    const draftId = created.body.data.id as number;
    const mediaId = await uploadMedia(
      agentA,
      draftId,
      { kind: 'photo', pointKey: 'exterior_front', contentType: 'image/jpeg' },
      JPG,
    );

    // Another partner can't delete it; the owner can
    await agentB.delete(`/partner/portal/checkpoints/${draftId}`).expect(404);
    await agentA.delete(`/partner/portal/checkpoints/${draftId}`).expect(200);
    await agentA.get(`/partner/portal/checkpoints/${draftId}`).expect(404);
    // Cascade removed the media row, so its file endpoint 404s too
    await agentA.get(`/partner/portal/checkpoints/media/${mediaId}/file`).expect(404);

    // A completed checkpoint is a berita acara — immutable, undeletable
    await agentA.delete(`/partner/portal/checkpoints/${deliveryId}`).expect(409);
  });
});
