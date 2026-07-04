import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface Envelope<T> {
  success: true;
  data: T;
  meta?: unknown;
}

/**
 * Wraps every successful controller return into the standard envelope
 * (PROJECT-BRIEF.md §6): `{ success: true, data, meta? }`.
 *
 * Convention: a controller returning exactly `{ data, meta }` is passed
 * through (paginated lists); any other value becomes `data` with no `meta`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<Envelope<unknown>> {
    return next.handle().pipe(
      map((body) => {
        if (isDataMeta(body)) {
          return { success: true as const, data: body.data, meta: body.meta };
        }
        return { success: true as const, data: body ?? null };
      }),
    );
  }
}

function isDataMeta(body: unknown): body is { data: unknown; meta: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    'data' in body &&
    'meta' in body &&
    Object.keys(body).length === 2
  );
}
