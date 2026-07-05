export interface SessionUser {
  id: number;
  email: string;
  fullName: string | null;
  roles: string[];
  partnerId: number | null;
  // true when the account must change its password before using the app
  mustChangePassword: boolean;
}

declare module 'express-session' {
  interface SessionData {
    user?: SessionUser;
  }
}

// Convenience shape for @CurrentUser() / guards
declare module 'express' {
  interface Request {
    user?: SessionUser;
  }
}
