import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // managed.ts on purpose: the partitioned detail tables are hand-written SQL
  schema: './src/db/schema/managed.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://fleet:fleet@localhost:5432/fleet',
  },
});
