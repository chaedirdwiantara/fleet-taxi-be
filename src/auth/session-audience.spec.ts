import type { SessionData } from 'express-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_ABSOLUTE_MAX_MS } from '../config/session';
import { resolveSessionUser } from './session-audience';
import { SessionUser } from './session.types';

const user = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: 1,
  email: 'a@fleet-taxi.id',
  fullName: 'A',
  roles: ['admin'],
  partnerId: null,
  mustChangePassword: false,
  ...over,
});

describe('resolveSessionUser (absolute session cap)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the slot user while the login is within the cap', () => {
    const session: Partial<SessionData> = { adminUser: user(), adminLoginAt: Date.now() };
    vi.advanceTimersByTime(SESSION_ABSOLUTE_MAX_MS - 1000);
    expect(resolveSessionUser('/admin/fleet/gojek/grid', session)?.id).toBe(1);
  });

  it('evicts a slot older than the cap and reports unauthenticated', () => {
    const session: Partial<SessionData> = { adminUser: user(), adminLoginAt: Date.now() };
    vi.advanceTimersByTime(SESSION_ABSOLUTE_MAX_MS + 1000);
    expect(resolveSessionUser('/admin/fleet/gojek/grid', session)).toBeUndefined();
    expect(session.adminUser).toBeUndefined();
    expect(session.adminLoginAt).toBeUndefined();
  });

  it('treats a legacy slot without loginAt as expired', () => {
    const session: Partial<SessionData> = {
      partnerUser: user({ roles: ['partner'], partnerId: 7 }),
    };
    expect(resolveSessionUser('/partner/portal/me', session)).toBeUndefined();
    expect(session.partnerUser).toBeUndefined();
  });

  it('expires audiences independently', () => {
    const session: Partial<SessionData> = {
      adminUser: user(),
      adminLoginAt: Date.now(),
    };
    vi.advanceTimersByTime(SESSION_ABSOLUTE_MAX_MS - 60_000);
    session.partnerUser = user({ id: 2, roles: ['partner'], partnerId: 7 });
    session.partnerLoginAt = Date.now();
    vi.advanceTimersByTime(120_000); // admin now past the cap, partner not
    expect(resolveSessionUser('/admin/users', session)).toBeUndefined();
    expect(resolveSessionUser('/partner/portal/me', session)?.id).toBe(2);
  });

  it('shared paths prefer the account that must change its password', () => {
    const session: Partial<SessionData> = {
      adminUser: user(),
      adminLoginAt: Date.now(),
      partnerUser: user({ id: 2, roles: ['partner'], partnerId: 7, mustChangePassword: true }),
      partnerLoginAt: Date.now(),
    };
    expect(resolveSessionUser('/auth/change-password', session)?.id).toBe(2);
  });
});
