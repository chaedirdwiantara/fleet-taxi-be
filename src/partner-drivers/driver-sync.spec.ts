import { describe, expect, it } from 'vitest';
import { exitDateOf, type ImportHorizon, type LastSeen } from './driver-sync.service';

// Pure half of the roster sync: given what each platform last saw of a driver
// and how far each platform's data reaches, has the driver left the fleet?
// Everything DB-shaped around it is covered by test/partner-drivers.e2e.spec.ts.

const horizon = (gojek: string | null, grab: string | null = null): ImportHorizon => ({
  gojek,
  grab,
});
const seen = (gojekLastSeen: string | null, grabLastSeen: string | null = null): LastSeen => ({
  gojekLastSeen,
  grabLastSeen,
});

describe('exitDateOf', () => {
  it('flags a gojek driver whose last row is older than the newest import', () => {
    expect(exitDateOf(seen('2026-08-11'), horizon('2026-08-19'))).toBe('2026-08-11');
  });

  it('keeps a driver seen on the newest import day', () => {
    expect(exitDateOf(seen('2026-08-19'), horizon('2026-08-19'))).toBeNull();
  });

  it('clears the exit as soon as the driver reappears in a later import', () => {
    const gone = seen('2026-08-11');
    expect(exitDateOf(gone, horizon('2026-08-19'))).toBe('2026-08-11');
    // next month's file carries the same driver again → nothing to clear by hand
    expect(exitDateOf(seen('2026-09-02'), horizon('2026-09-02'))).toBeNull();
  });

  it('never auto-exits a driver no platform knows (manually registered)', () => {
    expect(exitDateOf(seen(null, null), horizon('2026-08-19', '2026-08-19'))).toBeNull();
  });

  it('keeps a driver who left gojek but is still active on grab', () => {
    expect(
      exitDateOf(seen('2026-08-11', '2026-08-19'), horizon('2026-08-19', '2026-08-19')),
    ).toBeNull();
  });

  it('exits a driver stale on both platforms, dated by the newest of the two', () => {
    expect(exitDateOf(seen('2026-08-11', '2026-08-14'), horizon('2026-08-19', '2026-08-19'))).toBe(
      '2026-08-14',
    );
  });

  it('treats a grab-only driver by grab’s own horizon', () => {
    expect(exitDateOf(seen(null, '2026-08-10'), horizon('2026-08-19', '2026-08-19'))).toBe(
      '2026-08-10',
    );
    expect(exitDateOf(seen(null, '2026-08-19'), horizon('2026-08-19', '2026-08-19'))).toBeNull();
  });

  it('never exits against a platform with no data at all', () => {
    // grab table empty → its horizon is null, so a grab row can only mean "current"
    expect(exitDateOf(seen(null, '2026-08-10'), horizon('2026-08-19', null))).toBeNull();
  });
});
