import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SessionGuard } from '../common/guards/session.guard';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SessionUser } from './session.types';

/** Guard-let: admin console endpoints require an admin (or super_admin) session. */
function requireAdmin(user: SessionUser): void {
  if (!user.roles.includes('admin') && !user.roles.includes('super_admin')) {
    throw new UnauthorizedException('Admin account required');
  }
}

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Admin login — sets the session cookie (admin audience only)' })
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<SessionUser> {
    const user = await this.authService.validateCredentials(dto.email, dto.password);
    // Same message as bad credentials: don't reveal that a non-admin account exists.
    if (!user.roles.includes('admin') && !user.roles.includes('super_admin')) {
      throw new UnauthorizedException('Invalid credentials');
    }
    // Regenerate to prevent session fixation, then persist the user
    await new Promise<void>((resolve, reject) =>
      req.session.regenerate((err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
      ),
    );
    req.session.user = user;
    return user;
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Destroy the session' })
  async logout(@Req() req: Request): Promise<{ loggedOut: true }> {
    await new Promise<void>((resolve, reject) =>
      req.session.destroy((err) =>
        err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(),
      ),
    );
    return { loggedOut: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Current admin session user (401 for a non-admin session)' })
  me(@CurrentUser() user: SessionUser): SessionUser {
    requireAdmin(user);
    return user;
  }
}
