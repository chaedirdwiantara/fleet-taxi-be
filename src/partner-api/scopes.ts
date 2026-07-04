import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';

export const REQUIRED_SCOPES_KEY = 'required_api_scopes';
/** e.g. @RequireScopes('order:create') — checked against api_keys.scopes */
export const RequireScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);

/** Runs AFTER ApiKeyGuard (needs req.partner). */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? [];
    if (!required.length) return true;

    const partner = ctx.switchToHttp().getRequest<Request>().partner;
    const granted = partner?.scopes ?? [];
    const missing = required.filter((s) => !granted.includes(s));
    if (missing.length) {
      throw new ForbiddenException(`API key missing scope(s): ${missing.join(', ')}`);
    }
    return true;
  }
}

/** Rate-limits per API key (falls back to IP before authentication). */
@Injectable()
export class ApiKeyThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const partner = (req as unknown as Request).partner;
    if (partner) return Promise.resolve(`key:${partner.apiKeyId}`);
    const ips = (req as { ips?: string[]; ip?: string }).ips;
    return Promise.resolve(ips?.length ? ips[0]! : ((req as { ip?: string }).ip ?? 'unknown'));
  }
}
