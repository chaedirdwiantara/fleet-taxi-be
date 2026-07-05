/**
 * WebSocket gateway auth regression (M5 review, HIGH finding): the /rt gateway
 * must reject unauthenticated and non-admin connections and only let an
 * authenticated admin session subscribe to import rooms.
 * Needs docker-compose Postgres + Redis and applied migrations.
 */
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { corsOrigins, Env } from '../src/config/env';
import { buildSessionMiddleware } from '../src/config/session';
import { DatabaseService } from '../src/db/database.service';
import { RedisService } from '../src/db/redis.service';
import { partners, roles, userRoles, users } from '../src/db/schema';
import { RedisIoAdapter } from '../src/realtime/redis-io.adapter';

const RUN = `rt${Date.now()}`;
const PASSWORD = 'realtime-pw';
const ADMIN_EMAIL = `${RUN}-admin@test.example`;
const PARTNER_EMAIL = `${RUN}-partner@test.example`;

describe('realtime gateway auth (M5)', () => {
  let app: INestApplication;
  let database: DatabaseService;
  let baseUrl: string;
  const userIds: number[] = [];
  let partnerId: number;

  async function loginCookie(email: string, path = '/admin/auth/login'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post(path)
      .send({ email, password: PASSWORD })
      .expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    return setCookie[0]!.split(';')[0]!; // "sid=...."
  }

  /** Resolves 'subscribed' only if connected AND import:subscribe is acked true. */
  function probe(cookie?: string): Promise<'subscribed' | 'rejected'> {
    return new Promise((resolve) => {
      const socket: Socket = io(`${baseUrl}/rt`, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        extraHeaders: cookie ? { Cookie: cookie } : {},
      });
      let settled = false;
      const done = (r: 'subscribed' | 'rejected') => {
        if (settled) return;
        settled = true;
        socket.close();
        resolve(r);
      };
      socket.on('connect', () => {
        socket.emit('import:subscribe', { importId: 1 }, (ack: { subscribed?: boolean }) =>
          done(ack?.subscribed ? 'subscribed' : 'rejected'),
        );
      });
      socket.on('disconnect', () => done('rejected'));
      socket.on('connect_error', () => done('rejected'));
      setTimeout(() => done('rejected'), 4500);
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);

    const config = app.get(ConfigService<Env, true>);
    const adapter = new RedisIoAdapter(app, {
      redisUrl: config.get('REDIS_URL', { infer: true }),
      corsOrigin: corsOrigins({ CORS_ORIGINS: config.get('CORS_ORIGINS', { infer: true }) }),
      sessionMiddleware: buildSessionMiddleware(
        {
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          SESSION_SECRET: config.get('SESSION_SECRET', { infer: true }),
          COOKIE_DOMAIN: config.get('COOKIE_DOMAIN', { infer: true }),
        },
        app.get(RedisService),
      ),
    });
    await adapter.connectToRedis();
    app.useWebSocketAdapter(adapter);

    await app.init();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

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
    const partnerRoleId = roleRows.find((r) => r.name === 'partner')!.id;

    const [partner] = await db
      .insert(partners)
      .values({ code: `${RUN}-P`, name: 'RT Partner', type: 'shuttle' })
      .returning();
    partnerId = partner!.id;

    const [admin] = await db
      .insert(users)
      .values({ email: ADMIN_EMAIL, passwordHash: await argon2.hash(PASSWORD) })
      .returning();
    const [partnerUser] = await db
      .insert(users)
      .values({ email: PARTNER_EMAIL, passwordHash: await argon2.hash(PASSWORD), partnerId })
      .returning();
    userIds.push(admin!.id, partnerUser!.id);
    await db.insert(userRoles).values([
      { userId: admin!.id, roleId: adminRoleId },
      { userId: partnerUser!.id, roleId: partnerRoleId },
    ]);
  }, 30_000);

  afterAll(async () => {
    const { db } = database;
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(partners).where(eq(partners.id, partnerId));
    await app.close();
  });

  it('rejects an unauthenticated WebSocket connection', async () => {
    expect(await probe()).toBe('rejected');
  });

  it('rejects a non-admin (partner) session', async () => {
    const cookie = await loginCookie(PARTNER_EMAIL, '/partner/portal/login');
    expect(await probe(cookie)).toBe('rejected');
  });

  it('lets an authenticated admin connect and subscribe to an import room', async () => {
    const cookie = await loginCookie(ADMIN_EMAIL);
    expect(await probe(cookie)).toBe('subscribed');
  });
});
