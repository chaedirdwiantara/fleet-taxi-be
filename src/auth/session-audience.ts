import type { SessionData } from 'express-session';
import { SESSION_ABSOLUTE_MAX_MS } from '../config/session';
import { SessionUser } from './session.types';

export type Audience = 'admin' | 'partner';

/** The audience a request belongs to, from its path (no global prefix in use). */
export function audienceOfPath(path: string): Audience | 'shared' {
  if (path.startsWith('/partner/portal')) return 'partner';
  if (path.startsWith('/admin')) return 'admin';
  return 'shared'; // e.g. /auth/change-password — either audience
}

/**
 * Read one audience slot, enforcing the absolute session cap: a login older
 * than SESSION_ABSOLUTE_MAX_MS (or predating the cap — no loginAt recorded)
 * is evicted from the session and treated as unauthenticated.
 */
function liveSlotUser(session: Partial<SessionData>, audience: Audience): SessionUser | undefined {
  const userKey = audience === 'admin' ? 'adminUser' : 'partnerUser';
  const loginAtKey = audience === 'admin' ? 'adminLoginAt' : 'partnerLoginAt';
  const user = session[userKey];
  if (!user) return undefined;
  const loginAt = session[loginAtKey];
  if (loginAt === undefined || Date.now() - loginAt > SESSION_ABSOLUTE_MAX_MS) {
    delete session[userKey];
    delete session[loginAtKey];
    return undefined;
  }
  return user;
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
      return liveSlotUser(session, 'partner');
    case 'admin':
      return liveSlotUser(session, 'admin');
    default: {
      const admin = liveSlotUser(session, 'admin');
      const partner = liveSlotUser(session, 'partner');
      return [admin, partner].find((u) => u?.mustChangePassword) ?? admin ?? partner;
    }
  }
}
