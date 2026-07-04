import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { UsersService } from '../users/users.service';
import { SessionUser } from './session.types';

@Injectable()
export class AuthService {
  constructor(private readonly usersService: UsersService) {}

  static hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain);
  }

  async validateCredentials(email: string, password: string): Promise<SessionUser> {
    const user = await this.usersService.findByEmail(email);
    // Same error for unknown email / bad password / inactive — no user enumeration
    if (!user || !user.isActive) throw new UnauthorizedException('Invalid credentials');

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      partnerId: user.partnerId,
    };
  }
}
