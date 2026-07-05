import { z } from 'zod';

// Dev-only placeholder secrets that must never reach production.
const WEAK_SECRETS = new Set([
  'change-me',
  'dev-only-secret',
  'dev-only-pepper',
  'test-secret',
  'test-pepper',
]);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SESSION_SECRET: z.string().min(1),
    COOKIE_DOMAIN: z.string().min(1),
    // Comma-separated origin allowlist, e.g. "https://app.fleet-taxi.id,http://localhost:5173"
    CORS_ORIGINS: z.string().min(1),
    API_KEY_PEPPER: z.string().min(1),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    AWS_REGION: z.string().optional(),
    SWAGGER_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((env, ctx) => {
    // Fail fast if production is deployed with dev/weak secrets — a hardening guard.
    if (env.NODE_ENV !== 'production') return;
    for (const key of ['SESSION_SECRET', 'API_KEY_PEPPER'] as const) {
      const value = env[key];
      if (WEAK_SECRETS.has(value) || value.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'must be a strong secret (≥32 chars, not a dev placeholder) in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment variables:\n  ${issues}`);
  }
  return parsed.data;
}

export function corsOrigins(env: Pick<Env, 'CORS_ORIGINS'>): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
