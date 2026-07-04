import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Single OpenAPI document builder shared by /docs (main.ts) and
 * `pnpm openapi:export` — the backend is the single source of API truth.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('fleet-taxi-dashboard-api')
    .setDescription(
      'Fleet/deposit-reconciliation dashboard API. ' +
        'All money values are integer rupiah serialized as JSON numbers. ' +
        'Every response uses the standard envelope: ' +
        '`{ success: true, data, meta? }` on success, ' +
        '`{ success: false, error: { code, message, details? } }` on error.',
    )
    .setVersion('0.1.0')
    .addCookieAuth('sid', { type: 'apiKey', in: 'cookie', name: 'sid' }, 'session')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: 'Partner API key (external /partner/v1 only)',
      },
      'partner-api-key',
    )
    .build();

  return SwaggerModule.createDocument(app, config);
}
