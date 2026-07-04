import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { corsOrigins, Env } from './config/env';

/**
 * Shared app wiring used by main.ts, the OpenAPI export script, and e2e
 * tests, so all three run the exact same pipeline.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);

  app.use(cookieParser());

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
