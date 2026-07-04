/**
 * Writes openapi.json to the repo root. The frontend repo
 * (fleet-taxi-dashboard-web) generates its typed client from this file.
 * Run with: pnpm openapi:export
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { buildOpenApiDocument } from '../src/openapi';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);

  const document = buildOpenApiDocument(app);
  const outPath = join(__dirname, '..', 'openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n', 'utf8');

  await app.close();
  console.log(`OpenAPI schema written to ${outPath}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
