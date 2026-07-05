import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { hashPassword, verifyPassword } from './password';
import { SessionUser } from './session.types';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  static hashPassword(plain: string): Promise<string> {
    return hashPassword(plain);
  }

  async validateCredentials(email: string, password: string): Promise<SessionUser> {
    const user = await this.usersService.findByEmail(email);
    // Same error for unknown email / bad password / inactive — no user enumeration
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    // Best-effort: record the login timestamp (does not change auth semantics).
    await this.usersService.markLoggedIn(user.id);

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      partnerId: user.partnerId,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Self-service / first-login password change for the authenticated session
   * user. Verifies the current password, stores the new hash, and clears the
   * `mustChangePassword` flag. Returns the refreshed SessionUser so the caller
   * can update the session in place.
   */
  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<SessionUser> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    await this.usersService.updatePassword(userId, await hashPassword(newPassword));

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      partnerId: user.partnerId,
      mustChangePassword: false,
    };
  }
}
