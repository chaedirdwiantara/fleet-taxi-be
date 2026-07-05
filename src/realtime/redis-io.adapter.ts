import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { RequestHandler } from 'express';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

export interface RedisIoAdapterOptions {
  redisUrl: string;
  /** Explicit CORS allowlist — same as the HTTP surface, never reflect-any-origin. */
  corsOrigin: string[];
  /** Shared session middleware so the handshake carries req.session. */
  sessionMiddleware: RequestHandler;
}

/**
 * Swaps the default in-memory Socket.IO adapter for the Redis adapter (events
 * fan out across instances), pins CORS to the allowlist, and runs the session
 * middleware on the handshake so gateways can authenticate the connection.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(
    app: INestApplication,
    private readonly options: RedisIoAdapterOptions,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    this.pubClient = new Redis(this.options.redisUrl);
    this.subClient = this.pubClient.duplicate();
    await Promise.all([
      new Promise((res) => this.pubClient!.once('ready', res)),
      new Promise((res) => this.subClient!.once('ready', res)),
    ]);
    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.options.corsOrigin, credentials: true },
    }) as {
      adapter: (a: unknown) => void;
      engine: { use: (mw: RequestHandler) => void };
    };
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    // Attach the shared session to every handshake request (req.session).
    server.engine.use(this.options.sessionMiddleware);
    return server;
  }

  /** Fires on app shutdown (Nest socket module → adapter.dispose()). */
  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.allSettled([this.pubClient?.quit(), this.subClient?.quit()]);
  }
}
