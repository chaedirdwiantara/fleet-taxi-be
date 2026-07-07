import type { Request } from 'express';

// Promise wrappers around express-session's callback API.

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(toError(err)) : resolve())),
  );
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.save((err) => (err ? reject(toError(err)) : resolve())),
  );
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.destroy((err) => (err ? reject(toError(err)) : resolve())),
  );
}
