import type { SessionData } from 'express-session';
import { SessionUser } from './session.types';

export type Audience = 'admin' | 'partner';

/** The audience a request belongs to, from its path (no global prefix in use). */
export function audienceOfPath(path: string): Audience | 'shared' {
  if (path.startsWith('/partner/portal')) return 'partner';
  if (path.startsWith('/admin')) return 'admin';
  return 'shared'; // e.g. /auth/change-password — either audience
}

/**
 * Resolve the session user for a request's audience. Admin and partner keep
 * separate slots so one login never evicts the other. Shared surfaces prefer
 * the account still required to change its password (the first-login flow).
 */
export function resolveSessionUser(
  path: string,
  session: Partial<SessionData> | undefined,
): SessionUser | undefined {
  if (!session) return undefined;
  switch (audienceOfPath(path)) {
    case 'partner':
      return session.partnerUser;
    case 'admin':
      return session.adminUser;
    default:
      return (
        [session.adminUser, session.partnerUser].find((u) => u?.mustChangePassword) ??
        session.adminUser ??
        session.partnerUser
      );
  }
}
