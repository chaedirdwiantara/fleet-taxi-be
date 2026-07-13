import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { corsOrigins, Env } from './config/env';
import { buildSessionMiddleware } from './config/session';
import { RedisService } from './db/redis.service';

/**
 * Shared app wiring used by main.ts, the OpenAPI export script, and e2e
 * tests, so all three run the exact same pipeline.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const redis = app.get(RedisService);

  const isProd = config.get('NODE_ENV', { infer: true }) === 'production';

  // Behind Cloudflare + ALB in prod: trust the proxy so Secure cookies,
  // req.secure and per-key rate-limit IPs resolve correctly.
  if (isProd) {
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
      'trust proxy',
      1,
    );
  }

  // Security headers. CSP is disabled so Swagger UI's inline assets still load;
  // the API surface is JSON, where CSP is not the relevant control.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(cookieParser());

  // Checkpoint media upload sink takes a raw image body (dev path of the
  // presigned-upload flow); scoped to the route so JSON parsing is untouched.
  app.use('/partner/portal/checkpoints/media', express.raw({ type: 'image/*', limit: '6mb' }));
  app.use(
    buildSessionMiddleware(
      {
        NODE_ENV: config.get('NODE_ENV', { infer: true }),
        SESSION_SECRET: config.get('SESSION_SECRET', { infer: true }),
        COOKIE_DOMAIN: config.get('COOKIE_DOMAIN', { infer: true }),
      },
      redis,
    ),
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
