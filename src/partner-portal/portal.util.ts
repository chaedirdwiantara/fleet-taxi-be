import { UnauthorizedException } from '@nestjs/common';
import { SessionUser } from '../auth/session.types';

/**
 * Guard-let for every partner-portal endpoint: require the partner role + a
 * partnerId, and return that partnerId. The partner is ALWAYS taken from the
 * session here — never from a route/query/body param — so a partner can only
 * ever touch its own data.
 */
export function requirePartner(user: SessionUser): number {
  if (!user.roles.includes('partner') || user.partnerId == null) {
    throw new UnauthorizedException('Partner account required');
  }
  return user.partnerId;
}
