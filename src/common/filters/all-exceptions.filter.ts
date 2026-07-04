import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ErrorEnvelope {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Array<{ field: string; message: string }>;
  };
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_ERROR',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
};

/**
 * Maps every thrown error to the standard error envelope
 * (PROJECT-BRIEF.md §6). Never leaks stack traces or raw SQL.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: ErrorEnvelope['error']['details'];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as { message?: string | string[]; details?: unknown };
        if (Array.isArray(b.message)) {
          // class-validator via ValidationPipe: string[] of constraint messages
          message = 'Validation failed';
          details = b.message.map((m) => splitConstraintMessage(m));
        } else if (typeof b.message === 'string') {
          message = b.message;
        } else {
          message = exception.message;
        }
        if (Array.isArray(b.details)) {
          details = b.details as ErrorEnvelope['error']['details'];
        }
      }
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const envelope: ErrorEnvelope = {
      success: false,
      error: {
        code: STATUS_TO_CODE[status] ?? 'INTERNAL',
        message,
        ...(details ? { details } : {}),
      },
    };

    res.status(status).json(envelope);
  }
}

/**
 * class-validator messages look like "pickupAt must be a valid ISO date" —
 * the first token is the property name.
 */
function splitConstraintMessage(msg: string): { field: string; message: string } {
  const space = msg.indexOf(' ');
  if (space === -1) return { field: msg, message: msg };
  return { field: msg.slice(0, space), message: msg.slice(space + 1) };
}
