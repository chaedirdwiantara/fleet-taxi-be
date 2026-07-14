import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { DatabaseService } from '../db/database.service';
import {
  checkpoints,
  fleetImports,
  grabImports,
  partnerPlates,
  partners,
  roles,
  userRoles,
  users,
} from '../db/schema';

export interface UserWithRoles {
  id: number;
  email: string;
  passwordHash: string;
  fullName: string | null;
  isActive: boolean;
  partnerId: number | null;
  mustChangePassword: boolean;
  roles: string[];
}

/** Public shape returned by admin user-management endpoints (never the hash). */
export interface AdminUserRow {
  id: number;
  email: string;
  fullName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: string[];
  createdAt: Date;
  lastLoginAt: Date | null;
  partner: { id: number; code: string; name: string; type: string | null } | null;
}

export type UserListType = 'admin' | 'partner';

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async findByEmail(email: string): Promise<UserWithRoles | null> {
    const db = this.database.db;
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return null;
    return { ...this.toUserWithRoles(user), roles: await this.roleNamesFor(user.id) };
  }

  async findById(id: number): Promise<UserWithRoles | null> {
    const db = this.database.db;
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return null;
    return { ...this.toUserWithRoles(user), roles: await this.roleNamesFor(user.id) };
  }

  /**
   * Creates a login account. `roleNames` must reference existing roles.
   * New accounts are always flagged `mustChangePassword = true` — the admin
   * sets an initial password and the user is forced to change it on first login.
   * Throws 409 CONFLICT on a duplicate email.
   */
  async createUser(input: {
    email: string;
    fullName: string;
    password: string;
    roleNames: string[];
    partnerId?: number | null;
  }): Promise<AdminUserRow> {
    const db = this.database.db;
    const email = input.email.trim().toLowerCase();

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      throw new ConflictException('Email already in use');
    }

    const roleIds = await this.resolveRoleIds(input.roleNames);
    const passwordHash = await hashPassword(input.password);

    const created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email,
          passwordHash,
          fullName: input.fullName.trim(),
          partnerId: input.partnerId ?? null,
          mustChangePassword: true,
        })
        .returning();
      await tx.insert(userRoles).values(roleIds.map((roleId) => ({ userId: user!.id, roleId })));
      return user!;
    });

    const [row] = await this.listRowsByIds([created.id]);
    return row!;
  }

  /**
   * Lists admin/staff users (`type=admin`, partnerId IS NULL) or partner-portal
   * users (`type=partner`, partnerId IS NOT NULL), newest first.
   */
  async listUsers(
    type: UserListType,
    page: number,
    pageSize: number,
  ): Promise<{ data: AdminUserRow[]; total: number }> {
    const db = this.database.db;
    const scope = type === 'partner' ? isNotNull(users.partnerId) : isNull(users.partnerId);

    const [totalRow] = await db.select({ value: count() }).from(users).where(scope);
    const total = totalRow?.value ?? 0;

    const ids = await db
      .select({ id: users.id })
      .from(users)
      .where(scope)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const data = await this.listRowsByIds(ids.map((r) => r.id));
    return { data, total: total ?? 0 };
  }

  /**
   * Partial account edit (super_admin user-management). Only provided fields
   * change. Guards against locking everyone out by demoting/deactivating the
   * last active super_admin.
   */
  async updateUser(
    id: number,
    patch: {
      email?: string;
      fullName?: string;
      isActive?: boolean;
      roles?: string[];
      partnerId?: number;
      password?: string;
    },
  ): Promise<AdminUserRow> {
    const db = this.database.db;
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) throw new NotFoundException('User not found');

    const email = patch.email?.trim().toLowerCase();
    if (email && email !== target.email) {
      const [dupe] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (dupe) throw new ConflictException('Email already in use');
    }

    // Last-super-admin guard: block a change that would remove the final one.
    const dropsSuperAdmin =
      (patch.roles !== undefined && !patch.roles.includes('super_admin')) ||
      patch.isActive === false;
    if (dropsSuperAdmin) {
      const supers = await this.activeSuperAdminIds();
      if (supers.length === 1 && supers[0] === id) {
        throw new BadRequestException('Tidak bisa menonaktifkan/menurunkan super admin terakhir');
      }
    }

    const userSet: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (email) userSet.email = email;
    if (patch.fullName !== undefined) userSet.fullName = patch.fullName.trim();
    if (patch.isActive !== undefined) userSet.isActive = patch.isActive;
    if (patch.partnerId !== undefined) userSet.partnerId = patch.partnerId;
    if (patch.password) {
      userSet.passwordHash = await hashPassword(patch.password);
      userSet.mustChangePassword = true; // admin-reset → force a change on next login
    }

    const roleIds = patch.roles ? await this.resolveRoleIds(patch.roles) : null;

    await db.transaction(async (tx) => {
      await tx.update(users).set(userSet).where(eq(users.id, id));
      if (roleIds) {
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await tx.insert(userRoles).values(roleIds.map((roleId) => ({ userId: id, roleId })));
      }
    });

    const [row] = await this.listRowsByIds([id]);
    return row!;
  }

  /**
   * Hard-deletes an account. Refuses self-deletion and deleting the last active
   * super_admin. Import + checkpoint history is preserved by nulling the
   * `imported_by`/`created_by` FKs (no cascade), then the user + its role rows
   * (cascade) are removed. When the account is a partner's LAST portal user,
   * that partner's plate registrations are dropped too, so the admin fleet
   * grid's Rental Partner label (partner_plates ⋈ partners) re-syncs instead
   * of staying attributed to the deleted account's partner.
   */
  async deleteUser(actingUserId: number, id: number): Promise<{ deleted: true }> {
    if (actingUserId === id) {
      throw new BadRequestException('Tidak bisa menghapus akun sendiri');
    }
    const db = this.database.db;
    const [target] = await db
      .select({ id: users.id, partnerId: users.partnerId })
      .from(users)
      .where(eq(users.id, id));
    if (!target) throw new NotFoundException('User not found');

    const supers = await this.activeSuperAdminIds();
    if (supers.length === 1 && supers[0] === id) {
      throw new BadRequestException('Tidak bisa menghapus super admin terakhir');
    }

    await db.transaction(async (tx) => {
      await tx
        .update(fleetImports)
        .set({ importedBy: null })
        .where(eq(fleetImports.importedBy, id));
      await tx.update(grabImports).set({ importedBy: null }).where(eq(grabImports.importedBy, id));
      await tx.update(checkpoints).set({ createdBy: null }).where(eq(checkpoints.createdBy, id));

      if (target.partnerId != null) {
        const [remaining] = await tx
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.partnerId, target.partnerId), ne(users.id, id)));
        if ((remaining?.value ?? 0) === 0) {
          await tx.delete(partnerPlates).where(eq(partnerPlates.partnerId, target.partnerId));
        }
      }

      await tx.delete(users).where(eq(users.id, id)); // user_roles cascade
    });
    return { deleted: true };
  }

  /** Ids of active users that hold the super_admin role. */
  private async activeSuperAdminIds(): Promise<number[]> {
    const rows = await this.database.db
      .selectDistinct({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(roles.name, 'super_admin'), eq(users.isActive, true)));
    return rows.map((r) => r.userId);
  }

  /** Sets a new password hash and clears the must-change-password flag. */
  async updatePassword(userId: number, passwordHash: string): Promise<void> {
    await this.database.db
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  /** Records a successful login timestamp (best-effort, non-blocking of auth). */
  async markLoggedIn(userId: number): Promise<void> {
    await this.database.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, userId));
  }

  // ---- internals ---------------------------------------------------------

  private toUserWithRoles(user: typeof users.$inferSelect): Omit<UserWithRoles, 'roles'> {
    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      fullName: user.fullName,
      isActive: user.isActive,
      partnerId: user.partnerId,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private async roleNamesFor(userId: number): Promise<string[]> {
    const rows = await this.database.db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId));
    return rows.map((r) => r.name);
  }

  private async resolveRoleIds(roleNames: string[]): Promise<number[]> {
    const unique = [...new Set(roleNames)];
    const rows = await this.database.db
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(inArray(roles.name, unique));
    const missing = unique.filter((name) => !rows.some((r) => r.name === name));
    if (missing.length > 0) {
      throw new ConflictException(`Unknown role(s): ${missing.join(', ')}`);
    }
    return rows.map((r) => r.id);
  }

  /** Loads full admin rows (with roles + partner) for a set of user ids, preserving order. */
  private async listRowsByIds(ids: number[]): Promise<AdminUserRow[]> {
    if (ids.length === 0) return [];
    const db = this.database.db;

    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        isActive: users.isActive,
        mustChangePassword: users.mustChangePassword,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        partnerId: users.partnerId,
        partnerCode: partners.code,
        partnerName: partners.name,
        partnerType: partners.type,
      })
      .from(users)
      .leftJoin(partners, eq(partners.id, users.partnerId))
      .where(inArray(users.id, ids));

    const roleRows = await db
      .select({ userId: userRoles.userId, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, ids));

    const rolesByUser = new Map<number, string[]>();
    for (const r of roleRows) {
      const list = rolesByUser.get(r.userId) ?? [];
      list.push(r.name);
      rolesByUser.set(r.userId, list);
    }

    const byId = new Map<number, AdminUserRow>();
    for (const u of userRows) {
      byId.set(u.id, {
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        isActive: u.isActive,
        mustChangePassword: u.mustChangePassword,
        roles: (rolesByUser.get(u.id) ?? []).sort(),
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        partner:
          u.partnerId != null
            ? {
                id: u.partnerId,
                code: u.partnerCode ?? '',
                name: u.partnerName ?? '',
                type: u.partnerType ?? null,
              }
            : null,
      });
    }

    // Preserve the incoming id order (list ordering / freshly-created row).
    return ids.map((id) => byId.get(id)).filter((r): r is AdminUserRow => r != null);
  }
}
