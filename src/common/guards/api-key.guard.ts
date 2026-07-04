import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeysService, AuthenticatedPartner } from '../../partners/api-keys.service';

declare module 'express' {
  interface Request {
    partner?: AuthenticatedPartner;
  }
}

/**
 * Used ONLY by /partner/v1/*: validates `Authorization: Bearer <api_key>`
 * against hashed keys and attaches req.partner. No cookies on this surface.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing API key');
    }

    const partner = await this.apiKeysService.verifyKey(header.slice('Bearer '.length).trim());
    if (!partner) throw new UnauthorizedException('Invalid or revoked API key');

    req.partner = partner;
    return true;
  }
}
