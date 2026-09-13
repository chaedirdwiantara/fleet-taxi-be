/**
 * In-memory stand-in for the Gojek Fleet Partner Portal HTTP surface, driven
 * through the real GojekFleetPartnerClient (only `fetch` is faked). Shared by
 * the client unit spec and the sync e2e spec.
 */
export const PORTAL_BASE = 'https://fleetpartner.gojek.com/api/api/v1/';
export const PORTAL_TOKEN = 'jwt-token-abc';
export const PORTAL_REPORT_ID = 77;
export const PORTAL_FILE_URL = `${PORTAL_BASE}storage/report/${PORTAL_REPORT_ID}.csv`;

export interface FakePortalOptions {
  /** Account the portal accepts. `passwordDigest` = base64(md5(password)). */
  email: string;
  passwordDigest: string;
  /** Spreadsheet served for the download. */
  file: Buffer;
  /** How many `report/result` polls answer "still building" before READY. */
  pendingPolls?: number;
  /** Portal fails the report with this message instead of finishing it. */
  reportFailure?: string;
  /** Answer a wrong login with HTTP 401 instead of `{success:false}`. */
  loginHttp401?: boolean;
  /** Reject the Bearer token with HTTP 401 (expired session). */
  expiredToken?: boolean;
}

export interface FakePortalCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakePortal {
  fetch: typeof fetch;
  calls: FakePortalCall[];
  options: FakePortalOptions;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export function makeFakePortal(options: FakePortalOptions): FakePortal {
  const calls: FakePortalCall[] = [];
  let polls = 0;
  const state: FakePortal = { options, calls, fetch: undefined as unknown as typeof fetch };

  state.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, url, headers, body });
    const o = state.options;

    const respond = (): Response => {
      if (url === `${PORTAL_BASE}auth/login` && method === 'POST') {
        const b = body as { email?: string; password?: string };
        if (b.email === o.email && b.password === o.passwordDigest) {
          return json(200, { success: true, data: { token: PORTAL_TOKEN } });
        }
        return o.loginHttp401
          ? json(401, { success: false, message: 'Unauthorized' })
          : json(200, { success: false, message: 'Email atau kata sandi salah' });
      }

      if (headers.authorization !== `Bearer ${PORTAL_TOKEN}` || o.expiredToken) {
        return json(401, { success: false, message: 'Token expired' });
      }

      if (url === `${PORTAL_BASE}report/export` && method === 'POST') {
        return json(200, { success: true, data: { report_id: PORTAL_REPORT_ID } });
      }
      if (url.startsWith(`${PORTAL_BASE}report/result?report_id=`)) {
        if (o.reportFailure) {
          return json(200, {
            success: true,
            data: { id: PORTAL_REPORT_ID, status: 4, path: '', msg: o.reportFailure },
          });
        }
        polls++;
        if (polls <= (o.pendingPolls ?? 1)) {
          return json(200, { success: true, data: { id: PORTAL_REPORT_ID, status: 1, path: '' } });
        }
        return json(200, {
          success: true,
          data: { id: PORTAL_REPORT_ID, status: 3, path: PORTAL_FILE_URL, msg: '' },
        });
      }
      if (url === PORTAL_FILE_URL) {
        return new Response(new Uint8Array(o.file), {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        });
      }
      return json(404, { success: false, message: `no route ${method} ${url}` });
    };

    return Promise.resolve(respond());
  };

  return state;
}
