import RedisStore from 'connect-redis';
import type { RequestHandler } from 'express';
import session from 'express-session';
import type Redis from 'ioredis';
import { Env } from './env';

// Idle timeout: the cookie (and Redis TTL) slides forward on every request
// (`rolling: true`); 2h of inactivity ends the session.
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
// Absolute cap: a login is never valid longer than 12h regardless of activity.
// Enforced per audience slot in auth/session-audience.ts (rolling cookies can't).
export const SESSION_ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000;

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
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProd,
      // cross-subdomain app. <-> api. needs SameSite=None in prod
      sameSite: isProd ? 'none' : 'lax',
      domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
      maxAge: SESSION_IDLE_MS,
    },
  });
}
