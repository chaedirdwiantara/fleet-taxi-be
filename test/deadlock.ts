/**
 * Deadlock-tolerant teardown for the e2e specs.
 *
 * Spec files run in parallel workers against ONE database and share the
 * partitioned detail tables. Their cleanup blocks therefore race: a cascading
 * `DELETE FROM fleet_imports` takes RowExclusiveLock on a child partition while
 * another spec's `dropDetailPartition` wants ShareRowExclusiveLock on the
 * parent — opposite lock order, so Postgres picks a victim and raises 40P01.
 * It is a scheduling collision, not a product bug: the run's assertions have
 * already passed by the time teardown runs, yet the failure fails the job and
 * (in the Deploy workflow) silently skips the ECS deploy.
 *
 * Postgres documents retrying as the remedy for 40P01. Teardown statements are
 * all idempotent (`DELETE … WHERE`, `DROP TABLE IF EXISTS`), so replaying the
 * whole block is safe.
 */

/** Postgres deadlock_detected. Drizzle wraps driver errors — walk the chain. */
function isDeadlock(err: unknown): boolean {
  for (let e = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === '40P01') return true;
  }
  return false;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a cleanup block, retrying it as a unit when Postgres reports a deadlock.
 * Backs off progressively so the two racing teardowns don't re-collide.
 * Anything that is not a deadlock rethrows immediately.
 */
export async function withDeadlockRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isDeadlock(err)) throw err;
      await delay(attempt * 150);
    }
  }
}
