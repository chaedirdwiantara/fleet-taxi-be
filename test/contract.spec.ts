/**
 * API contract lock (M5). The exported OpenAPI schema is the single source of
 * API truth the frontend generates its typed client from; any endpoint added,
 * removed or renamed must be an intentional edit to this list. A failure here
 * flags a breaking contract change that has to land in the backend first.
 * Needs Postgres + Redis (the app instantiates its providers to build the doc).
 */
import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';

const EXPECTED_OPERATIONS = [
  'DELETE /admin/fleet/gojek/exceptions/{id}',
  'DELETE /admin/fleet/{platform}/imports/{id}',
  'DELETE /admin/users/{id}',
  'DELETE /partner/portal/checkpoints/{id}/media/{mediaId}',
  'DELETE /partner/portal/plates/{id}',
  'GET /admin/auth/me',
  'GET /admin/fleet/gojek/cell',
  'GET /admin/fleet/gojek/details/{detailId}',
  'GET /admin/fleet/gojek/exceptions',
  'GET /admin/fleet/gojek/grid',
  'GET /admin/fleet/gojek/performers',
  'GET /admin/fleet/gojek/summary',
  'GET /admin/fleet/grab/cell',
  'GET /admin/fleet/grab/grid',
  'GET /admin/fleet/grab/performers',
  'GET /admin/fleet/{platform}/imports',
  'GET /admin/fleet/{platform}/imports/{id}',
  'GET /admin/fleet/{platform}/targets/{plate}',
  'GET /admin/partners',
  'GET /admin/users',
  'GET /health',
  'GET /partner/portal/checkpoints',
  'GET /partner/portal/checkpoints/media/{mediaId}/file',
  'GET /partner/portal/checkpoints/{id}',
  'GET /partner/portal/checkpoints/{id}/comparison',
  'GET /partner/portal/checkpoints/{id}/pdf',
  'GET /partner/portal/dashboard',
  'GET /partner/portal/fleet/gojek/cell',
  'GET /partner/portal/fleet/gojek/grid',
  'GET /partner/portal/fleet/gojek/summary',
  'GET /partner/portal/fleet/grab/cell',
  'GET /partner/portal/fleet/grab/grid',
  'GET /partner/portal/me',
  'GET /partner/portal/orders',
  'GET /partner/portal/orders/export',
  'GET /partner/portal/orders/{id}',
  'GET /partner/portal/plates',
  'GET /partner/v1/orders',
  'GET /partner/v1/orders/{id}',
  'GET /partner/v1/pricelist',
  'PATCH /admin/users/{id}',
  'PATCH /partner/portal/checkpoints/{id}',
  'PATCH /partner/portal/checkpoints/{id}/points/{pointKey}',
  'POST /admin/auth/login',
  'POST /admin/auth/logout',
  'POST /admin/fleet/gojek/edit-driver',
  'POST /admin/fleet/gojek/exceptions',
  'POST /admin/fleet/{platform}/imports',
  'POST /admin/partners',
  'POST /admin/partners/{id}/api-keys',
  'POST /admin/partners/{id}/users',
  'POST /admin/users',
  'POST /auth/change-password',
  'POST /partner/portal/checkpoints',
  'POST /partner/portal/checkpoints/{id}/complete',
  'POST /partner/portal/checkpoints/{id}/media/presign',
  'POST /partner/portal/checkpoints/{id}/media/{mediaId}/confirm',
  'POST /partner/portal/login',
  'POST /partner/portal/logout',
  'POST /partner/portal/plates',
  'POST /partner/v1/orders',
  'PUT /admin/fleet/{platform}/targets/{plate}',
  'PUT /partner/portal/checkpoints/media/{mediaId}/upload',
  'PUT /partner/portal/plates/{id}',
];

function operations(doc: OpenAPIObject): string[] {
  const ops: string[] = [];
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of Object.keys(methods)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
        ops.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return ops.sort();
}

describe('OpenAPI contract (M5)', () => {
  let app: INestApplication;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    doc = buildOpenApiDocument(app);
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  it('exposes exactly the agreed operation set', () => {
    expect(operations(doc)).toEqual(EXPECTED_OPERATIONS);
  });

  it('declares both auth schemes (cookie session + partner bearer key)', () => {
    const schemes = doc.components?.securitySchemes ?? {};
    expect(schemes).toHaveProperty('session');
    expect(schemes).toHaveProperty('partner-api-key');
  });

  it('secures external /partner/v1 operations with the bearer key, never cookies', () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      if (!path.startsWith('/partner/v1')) continue;
      for (const op of Object.values(methods as Record<string, { security?: object[] }>)) {
        if (typeof op !== 'object' || !('security' in op)) continue;
        const keys = (op.security ?? []).flatMap((s) => Object.keys(s));
        expect(keys).toContain('partner-api-key');
        expect(keys).not.toContain('session');
      }
    }
  });

  it('documents money-as-JSON-number and the standard envelope in the description', () => {
    expect(doc.info.description).toContain('integer rupiah');
    expect(doc.info.description).toContain('envelope');
  });
});
