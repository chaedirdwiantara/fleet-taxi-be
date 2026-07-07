import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { resolveSessionUser } from '../../auth/session-audience';

/**
 * Validates the Redis-backed cookie session and attaches req.user. Resolves the
 * user for the request's AUDIENCE (admin vs partner portal) from its own session
 * slot, so an admin login and a partner login coexist in one browser without
 * clobbering each other. Used by all /admin/* and /partner/portal/* surfaces —
 * NEVER by /partner/v1.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = resolveSessionUser(req.path, req.session);
    if (!user) throw new UnauthorizedException('Not authenticated');
    req.user = user;
    return true;
  }
}
