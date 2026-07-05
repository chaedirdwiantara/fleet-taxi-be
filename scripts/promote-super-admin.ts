/**
 * One-off admin script: ensure a super_admin account exists.
 *
 * The account-creation feature (create admin/partner users from /admin) is
 * gated to super_admin, but the seed only creates a plain `admin`. Run this once
 * per environment to bootstrap the first super_admin — either PROMOTE an existing
 * user or CREATE a new one.
 *
 *   # promote the seeded admin (recommended for the existing prod account):
 *   SUPER_ADMIN_EMAIL=admin@fleet-taxi.id pnpm ts-node -r tsconfig-paths/register scripts/promote-super-admin.ts
 *
 *   # create a brand-new super_admin (email must not exist):
 *   SUPER_ADMIN_EMAIL=root@fleet-taxi.id SUPER_ADMIN_PASSWORD='a-strong-password' \
 *     pnpm ts-node -r tsconfig-paths/register scripts/promote-super-admin.ts
 *
 * In prod, run it the same way the migrate/seed tasks run (a one-off ECS task).
 * Idempotent: re-running only ensures the super_admin role is attached.
 */
import { NestFactory } from '@nestjs/core';
import * as argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { DatabaseService } from '../src/db/database.service';
import { roles, userRoles, users } from '../src/db/schema';

async function main(): Promise<void> {
  const email = (process.env.SUPER_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!email) {
    throw new Error('SUPER_ADMIN_EMAIL is required');
  }
  const password = process.env.SUPER_ADMIN_PASSWORD;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const { db } = app.get(DatabaseService);

  // Ensure the super_admin role exists.
  await db.insert(roles).values({ name: 'super_admin' }).onConflictDoNothing();
  const [superRole] = await db.select().from(roles).where(eq(roles.name, 'super_admin'));
  if (!superRole) throw new Error('failed to ensure super_admin role');

  let [user] = await db.select().from(users).where(eq(users.email, email));

  if (!user) {
    if (!password) {
      throw new Error(
        `no user with email ${email}; set SUPER_ADMIN_PASSWORD to create one, or use an existing email to promote`,
      );
    }
    [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await argon2.hash(password),
        fullName: 'Super Admin',
        // A freshly-created bootstrap account should also rotate its password.
        mustChangePassword: true,
      })
      .returning();
    console.log(`created super_admin user: ${email}`);
  } else {
    console.log(`promoting existing user to super_admin: ${email}`);
  }

  // Attach the super_admin role (idempotent).
  const existing = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, user!.id), eq(userRoles.roleId, superRole.id)));
  if (existing.length === 0) {
    await db.insert(userRoles).values({ userId: user!.id, roleId: superRole.id });
    console.log('super_admin role attached.');
  } else {
    console.log('user already has the super_admin role.');
  }

  await app.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
