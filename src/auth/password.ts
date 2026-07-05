import * as argon2 from 'argon2';

/**
 * Single source of truth for human-account password hashing (argon2 defaults).
 * Kept dependency-free (no Nest DI) so both AuthService and UsersService can use
 * it without creating a circular module dependency.
 */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
