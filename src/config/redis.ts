export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  db: number;
}

/** Parses a redis:// URL into ioredis/BullMQ connection options. */
export function parseRedisConnection(url: string): RedisConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    db: Number(u.pathname.slice(1)) || 0,
  };
}
