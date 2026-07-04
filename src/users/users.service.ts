import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { roles, userRoles, users } from '../db/schema';

export interface UserWithRoles {
  id: number;
  email: string;
  passwordHash: string;
  fullName: string | null;
  isActive: boolean;
  partnerId: number | null;
  roles: string[];
}

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async findByEmail(email: string): Promise<UserWithRoles | null> {
    const db = this.database.db;
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return null;

    const roleRows = await db
      .select({ name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, user.id));

    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      fullName: user.fullName,
      isActive: user.isActive,
      partnerId: user.partnerId,
      roles: roleRows.map((r) => r.name),
    };
  }
}
