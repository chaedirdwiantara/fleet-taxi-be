// Minimal env so ConfigModule's zod validation passes in unit/e2e tests
// that don't need real infrastructure.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://fleet:fleet@localhost:5432/fleet';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.SESSION_SECRET ??= 'test-secret';
process.env.COOKIE_DOMAIN ??= 'localhost';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';
process.env.API_KEY_PEPPER ??= 'test-pepper';
process.env.SWAGGER_ENABLED ??= 'true';
process.env.LOG_LEVEL ??= 'silent'; // keep test output clean
