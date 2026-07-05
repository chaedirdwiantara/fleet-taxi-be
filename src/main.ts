import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { corsOrigins, Env } from './config/env';
import { buildSessionMiddleware } from './config/session';
import { RedisService } from './db/redis.service';
import { buildOpenApiDocument } from './openapi';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // bufferLogs so early framework logs are flushed through pino once wired
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.flushLogs();

  const config = app.get(ConfigService<Env, true>);

  configureApp(app);

  // Redis-backed Socket.IO adapter: fans out across instances, pins CORS to
  // the allowlist, and shares the HTTP session with the WS handshake.
  const ioAdapter = new RedisIoAdapter(app, {
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
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const document = buildOpenApiDocument(app);
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
  }

  // Run onModuleDestroy hooks (DB/Redis cleanup) on SIGTERM/SIGINT
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }));
  app.get(Logger).log(`Listening on port ${config.get('PORT', { infer: true })}`, 'Bootstrap');
}

void bootstrap();
