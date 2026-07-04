import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { Env } from './config/env';
import { ImportModule } from './import/import.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { validateEnv } from './config/env';
import { DrizzleModule } from './db/drizzle.module';
import { HealthController } from './health/health.controller';
import { PartnersModule } from './partners/partners.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const u = new URL(config.get('REDIS_URL', { infer: true }));
        return {
          connection: {
            host: u.hostname,
            port: Number(u.port || 6379),
            password: u.password || undefined,
            db: Number(u.pathname.slice(1)) || 0,
            maxRetriesPerRequest: null, // required by BullMQ workers
          },
        };
      },
    }),
    DrizzleModule,
    UsersModule,
    AuthModule,
    PartnersModule,
    RealtimeModule,
    ImportModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
