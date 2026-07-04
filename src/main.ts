import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { Env } from './config/env';
import { buildOpenApiDocument } from './openapi';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Env, true>);

  configureApp(app);

  // Redis-backed Socket.IO adapter so events fan out across instances
  const ioAdapter = new RedisIoAdapter(app, config.get('REDIS_URL', { infer: true }));
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const document = buildOpenApiDocument(app);
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: 'docs-json',
    });
  }

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
