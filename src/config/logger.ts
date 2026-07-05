import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { Env } from './env';

/**
 * Structured logging config (nestjs-pino). Secrets are redacted at the
 * serializer level so an Authorization header, cookie, or API key can never
 * reach the logs (PROJECT-BRIEF.md §4: never log API keys or session secrets).
 */
export function buildLoggerParams(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): Params {
  const isDev = env.NODE_ENV === 'development';

  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      // Pretty, colorized output in dev; line-delimited JSON everywhere else.
      transport: isDev
        ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:standard' } }
        : undefined,
      // Correlate every log line for a request; honor an upstream header if present.
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const existing = req.headers['x-request-id'];
        const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // Belt-and-suspenders: redact anything sensitive that slips into a log object.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.pepper',
          '*.password',
          '*.passwordHash',
          '*.keyHash',
          '*.rawKey',
          '*.apiKey',
          '*.token',
        ],
        remove: true,
      },
      serializers: {
        req(req: { method: string; url: string; id: string }) {
          return { id: req.id, method: req.method, url: req.url };
        },
        res(res: { statusCode: number }) {
          return { statusCode: res.statusCode };
        },
      },
      customLogLevel: (_req, res, err) => {
        if (res.statusCode >= 500 || err) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      // Health probes are noisy; drop them from the access log.
      autoLogging: {
        ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/health'),
      },
    },
  };
}
