/**
 * Idempotent dev/staging seed: roles, an admin user, a demo partner with a
 * partner-portal user, and one API key (raw key printed ONCE).
 * Run with: pnpm db:seed  (override passwords via SEED_ADMIN_PASSWORD etc.)
 */
import { NestFactory } from '@nestjs/core';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/db/database.service';
import { partners, roles, userRoles, users } from '../src/db/schema';
import { ApiKeysService } from '../src/partners/api-keys.service';

const ROLE_NAMES = ['super_admin', 'admin', 'partner', 'finance'] as const;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { db } = app.get(DatabaseService);
  const apiKeysService = app.get(ApiKeysService);

  // Roles
  await db
    .insert(roles)
    .values(ROLE_NAMES.map((name) => ({ name })))
    .onConflictDoNothing();
  const roleRows = await db.select().from(roles);
  const roleId = (name: string): number => {
    const row = roleRows.find((r) => r.name === name);
    if (!row) throw new Error(`role missing: ${name}`);
    return row.id;
  };

  // Admin user
  const adminEmail = 'admin@fleet-taxi.id';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin-dev-password';
  let [admin] = await db.select().from(users).where(eq(users.email, adminEmail));
  if (!admin) {
    [admin] = await db
      .insert(users)
      .values({
        email: adminEmail,
        passwordHash: await argon2.hash(adminPassword),
        fullName: 'Fleet Admin',
      })
      .returning();
    await db
      .insert(userRoles)
      .values({ userId: admin!.id, roleId: roleId('admin') })
      .onConflictDoNothing();
    console.log(`admin user created: ${adminEmail} / ${adminPassword}`);
  } else {
    console.log(`admin user exists: ${adminEmail}`);
  }

  // Demo partner + portal user
  let [bhisa] = await db.select().from(partners).where(eq(partners.code, 'BHISA'));
  if (!bhisa) {
    [bhisa] = await db
      .insert(partners)
      .values({ code: 'BHISA', name: 'Bhisa Shuttle', type: 'shuttle' })
      .returning();
    console.log('partner created: BHISA');
  }

  const partnerEmail = 'partner@bhisa.example';
  const partnerPassword = process.env.SEED_PARTNER_PASSWORD ?? 'partner-dev-password';
  const [partnerUser] = await db.select().from(users).where(eq(users.email, partnerEmail));
  if (!partnerUser) {
    const [pu] = await db
      .insert(users)
      .values({
        email: partnerEmail,
        passwordHash: await argon2.hash(partnerPassword),
        fullName: 'Bhisa Portal User',
        partnerId: bhisa!.id,
      })
      .returning();
    await db
      .insert(userRoles)
      .values({ userId: pu!.id, roleId: roleId('partner') })
      .onConflictDoNothing();
    console.log(`partner user created: ${partnerEmail} / ${partnerPassword}`);

    const key = await apiKeysService.createKey({
      partnerId: bhisa!.id,
      label: 'seed key',
      scopes: ['pricelist', 'order:create', 'order:read'],
      rateLimit: 60,
    });
    console.log(`BHISA API key (SHOWN ONCE — store it now): ${key.rawKey}`);
  } else {
    console.log(`partner user exists: ${partnerEmail}`);
  }

  await app.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
