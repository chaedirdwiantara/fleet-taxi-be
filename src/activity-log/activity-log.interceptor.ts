import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { audienceOfPath } from '../auth/session-audience';
import { SessionUser } from '../auth/session.types';
import { ACTIVITY_ACTIONS, ActivityLogService } from './activity-log.service';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Paths whose events are recorded explicitly (login/logout/password change)
 * or that must never be audited (api-key machine traffic, health probes).
 */
const SKIP_PREFIXES = ['/partner/v1', '/health'];
const SKIP_PATHS = new Set([
  '/admin/auth/login',
  '/admin/auth/logout',
  '/partner/portal/login',
  '/partner/portal/logout',
  '/auth/change-password',
]);

const ACTION_BY_METHOD: Record<string, string> = {
  POST: ACTIVITY_ACTIONS.create,
  PATCH: ACTIVITY_ACTIONS.update,
  PUT: ACTIVITY_ACTIONS.update,
  DELETE: ACTIVITY_ACTIONS.delete,
};

/**
 * Global audit interceptor: records every session-authenticated write
 * (POST/PATCH/PUT/DELETE) from the admin console and partner portal.
 * Reads are never logged; auth events are captured at their controllers.
 * Purely observational — it never alters the response or swallows errors.
 */
@Injectable()
export class ActivityLogInterceptor implements NestInterceptor {
  constructor(private readonly activityLog: ActivityLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = req.user;
    const path = req.path;

    if (
      !user ||
      !MUTATING_METHODS.has(req.method) ||
      SKIP_PATHS.has(path) ||
      SKIP_PREFIXES.some((p) => path.startsWith(p))
    ) {
      return next.handle();
    }

    const audienceGuess = audienceOfPath(path);
    const base = {
      // shared surfaces (no /admin or /partner/portal prefix) attribute to the
      // audience the account belongs to: partner users carry a partnerId
      audience:
        audienceGuess === 'shared' ? (user.partnerId != null ? 'partner' : 'admin') : audienceGuess,
      actorId: user.id,
      actorEmail: user.email,
      actorName: user.fullName,
      partnerId: user.partnerId,
      action: ACTION_BY_METHOD[req.method] ?? ACTIVITY_ACTIONS.update,
      method: req.method,
      path,
      resourceSummary: Object.keys(req.params ?? {}).length ? JSON.stringify(req.params) : null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    } as const;

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<Response>();
        this.activityLog.record({ ...base, status: 'success', statusCode: res.statusCode });
      }),
      catchError((err: unknown) => {
        const statusCode =
          typeof (err as { getStatus?: () => number }).getStatus === 'function'
            ? (err as { getStatus: () => number }).getStatus()
            : 500;
        this.activityLog.record({ ...base, status: 'failure', statusCode });
        return throwError(() => err);
      }),
    );
  }
}
