/**
 * Runtime migration runner used in production (and CI) so the deploy image
 * needs no dev-only drizzle-kit. Applies the same journal/SQL files that
 * `drizzle-kit migrate` does — including the hand-written partition DDL.
 * Run with: node dist/db/migrate.js   (or `pnpm db:migrate:prod`)
 *
 * Deliberately depends on DATABASE_URL only — a migration task shouldn't
 * require the full app env (session secret, CORS, etc.).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

function loadDotEnvIfPresent(): void {
  // In prod the environment is injected by the orchestrator; locally we read .env.
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations');

  const migrationsFolder =
    process.env.MIGRATIONS_DIR ?? resolve(process.cwd(), 'src/db/migrations');

  const client = postgres(databaseUrl, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log(`Migrations applied from ${migrationsFolder}`);
  } finally {
    await client.end();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
