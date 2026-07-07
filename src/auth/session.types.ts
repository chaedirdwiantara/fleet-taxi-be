export interface SessionUser {
  id: number;
  email: string;
  fullName: string | null;
  roles: string[];
  partnerId: number | null;
  // true when the account must change its password before using the app
  mustChangePassword: boolean;
}

// Admin and partner-portal are SEPARATE audiences that can be logged in at the
// same time in one browser (they share the `sid` cookie). Keeping a slot per
// audience means logging into one never clobbers the other's session.
declare module 'express-session' {
  interface SessionData {
    adminUser?: SessionUser;
    partnerUser?: SessionUser;
  }
}

// Convenience shape for @CurrentUser() / guards
declare module 'express' {
  interface Request {
    user?: SessionUser;
  }
}
