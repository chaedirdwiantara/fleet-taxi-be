import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Validates the Redis-backed cookie session and attaches req.user.
 * Used by all /admin/* and /partner/portal/* surfaces — NEVER by /partner/v1.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = req.session?.user;
    if (!user) throw new UnauthorizedException('Not authenticated');
    req.user = user;
    return true;
  }
}
