import RedisStore from 'connect-redis';
import type { RequestHandler } from 'express';
import session from 'express-session';
import type Redis from 'ioredis';
import { Env } from './env';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Builds the Redis-backed session middleware. Shared by the HTTP pipeline
 * (app.setup.ts) and the Socket.IO handshake (RedisIoAdapter) so the WS
 * gateway can read the same authenticated session as the REST API.
 */
export function buildSessionMiddleware(
  env: Pick<Env, 'NODE_ENV' | 'SESSION_SECRET' | 'COOKIE_DOMAIN'>,
  redis: Redis,
): RequestHandler {
  const isProd = env.NODE_ENV === 'production';
  return session({
    store: new RedisStore({ client: redis, prefix: 'sess:' }),
    name: 'sid',
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      // cross-subdomain app. <-> api. needs SameSite=None in prod
      sameSite: isProd ? 'none' : 'lax',
      domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
      maxAge: SESSION_MAX_AGE_MS,
    },
  });
}
