import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { ActivityLogInterceptor } from './activity-log/activity-log.interceptor';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { Env, validateEnv } from './config/env';
import { buildLoggerParams } from './config/logger';
import { parseRedisConnection } from './config/redis';
import { DrizzleModule } from './db/drizzle.module';
import { FleetModule } from './fleet/fleet.module';
import { GrabModule } from './grab/grab.module';
import { HealthModule } from './health/health.module';
import { ImportModule } from './import/import.module';
import { PartnerApiModule } from './partner-api/partner-api.module';
import { PartnerDriversModule } from './partner-drivers/partner-drivers.module';
import { PartnerPortalModule } from './partner-portal/partner-portal.module';
import { PartnerRentalsModule } from './partner-rentals/partner-rentals.module';
import { DepositInstallmentsModule } from './deposit-installments/deposit-installments.module';
import { PartnersModule } from './partners/partners.module';
import { RealtimeModule } from './realtime/realtime.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        buildLoggerParams({
          NODE_ENV: config.get('NODE_ENV', { infer: true }),
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
        }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          ...parseRedisConnection(config.get('REDIS_URL', { infer: true })),
          maxRetriesPerRequest: null, // required by BullMQ workers
        },
      }),
    }),
    // Applied via ApiKeyThrottlerGuard on /partner/v1/* controllers only
    ThrottlerModule.forRoot([{ name: 'partner-api', ttl: 60_000, limit: 60 }]),
    DrizzleModule,
    HealthModule,
    UsersModule,
    ActivityLogModule,
    AuthModule,
    PartnersModule,
    RealtimeModule,
    ImportModule,
    FleetModule,
    GrabModule,
    PartnerPortalModule,
    PartnerRentalsModule,
    DepositInstallmentsModule,
    PartnerDriversModule,
    PartnerApiModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ActivityLogInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
