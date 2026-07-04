import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import RedisStore from 'connect-redis';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { corsOrigins, Env } from './config/env';
import { RedisService } from './db/redis.service';

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Shared app wiring used by main.ts, the OpenAPI export script, and e2e
 * tests, so all three run the exact same pipeline.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const redis = app.get(RedisService);

  const isProd = config.get('NODE_ENV', { infer: true }) === 'production';
  const cookieDomain = config.get('COOKIE_DOMAIN', { infer: true });

  app.use(cookieParser());
  app.use(
    session({
      store: new RedisStore({ client: redis, prefix: 'sess:' }),
      name: 'sid',
      secret: config.get('SESSION_SECRET', { infer: true }),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProd,
        // cross-subdomain app. <-> api. needs SameSite=None in prod
        sameSite: isProd ? 'none' : 'lax',
        domain: cookieDomain === 'localhost' ? undefined : cookieDomain,
        maxAge: SESSION_MAX_AGE_MS,
      },
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.enableCors({
    origin: corsOrigins({ CORS_ORIGINS: config.get('CORS_ORIGINS', { infer: true }) }),
    credentials: true,
  });
}
