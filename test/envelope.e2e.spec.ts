import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsISO8601, IsString } from 'class-validator';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import type { Paginated } from '../src/common/dto/paginated.dto';

class CreateThingDto {
  @IsString()
  name!: string;

  @IsISO8601()
  pickupAt!: string;
}

@Controller('test-fixture')
class FixtureController {
  @Get('paginated')
  paginated(): Paginated<{ id: number }> {
    return {
      data: [{ id: 1 }, { id: 2 }],
      meta: { page: 1, pageSize: 50, total: 2 },
    };
  }

  @Post('things')
  create(@Body() dto: CreateThingDto): CreateThingDto {
    return dto;
  }
}

describe('response envelope (M0 contract)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [FixtureController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('wraps a bare return into { success: true, data } with no meta', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({
      success: true,
      data: { status: 'ok', uptimeSeconds: expect.any(Number) },
    });
    expect(res.body).not.toHaveProperty('meta');
  });

  it('passes { data, meta } through for paginated lists', async () => {
    const res = await request(app.getHttpServer()).get('/test-fixture/paginated').expect(200);
    expect(res.body).toEqual({
      success: true,
      data: [{ id: 1 }, { id: 2 }],
      meta: { page: 1, pageSize: 50, total: 2 },
    });
  });

  it('maps validation failures to VALIDATION_ERROR with field details', async () => {
    const res = await request(app.getHttpServer())
      .post('/test-fixture/things')
      .send({ name: 123 })
      .expect(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Validation failed');
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('name');
    expect(fields).toContain('pickupAt');
  });

  it('rejects unknown properties (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/test-fixture/things')
      .send({ name: 'x', pickupAt: '2026-07-04T10:00:00Z', hacker: true })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('maps unknown routes to the NOT_FOUND error envelope', async () => {
    const res = await request(app.getHttpServer()).get('/nope').expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body).not.toHaveProperty('error.stack');
  });
});
