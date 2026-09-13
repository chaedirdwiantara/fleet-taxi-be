import { describe, expect, it } from 'vitest';
import {
  makeFakePortal,
  PORTAL_BASE,
  PORTAL_FILE_URL,
  PORTAL_REPORT_ID,
  PORTAL_TOKEN,
} from '../../test/helpers/gojek-portal-fetch';
import {
  GOJEK_PORTAL_DEFAULTS,
  GojekFleetPartnerClient,
  GojekPortalError,
  REPORT_TYPE_RECONCILIATION,
} from './gojek-fleet-partner.client';

const EMAIL = 'finance@rental.id';
const PASSWORD = 'Rahasia123!';
const DIGEST = GojekFleetPartnerClient.passwordDigest(PASSWORD);
const FILE = Buffer.from('Date & Time(JKT),Driver ID\n01/03/2026,D1\n');

const noSleep = () => Promise.resolve();

function makeClient(portal: ReturnType<typeof makeFakePortal>) {
  return new GojekFleetPartnerClient(
    { pollIntervalMs: 1 },
    { fetch: portal.fetch, sleep: noSleep },
  );
}

async function expectPortalError(p: Promise<unknown>, kind: GojekPortalError['kind']) {
  await expect(p).rejects.toBeInstanceOf(GojekPortalError);
  await expect(p).rejects.toMatchObject({ kind });
}

describe('GojekFleetPartnerClient', () => {
  it('passwordDigest is base64(md5 hex) — what the portal login form sends', () => {
    // md5("password") = 5f4dcc3b5aa765d61d8327deb882cf99
    expect(GojekFleetPartnerClient.passwordDigest('password')).toBe(
      Buffer.from('5f4dcc3b5aa765d61d8327deb882cf99').toString('base64'),
    );
  });

  it('builds ABSOLUTE portal URLs even when constructed with no options (DI default)', () => {
    const client = new GojekFleetPartnerClient();
    expect(client.resolveUrl('auth/login')).toBe(`${PORTAL_BASE}auth/login`);
    expect(client.resolveUrl('/report/result?report_id=1')).toBe(
      `${PORTAL_BASE}report/result?report_id=1`,
    );
    expect(client.resolveUrl(PORTAL_FILE_URL)).toBe(PORTAL_FILE_URL); // absolute passes through
    expect(GOJEK_PORTAL_DEFAULTS.baseUrl).toMatch(/^https:\/\/fleetpartner\.gojek\.com\//);
  });

  it('runs the full login → export → poll → download flow against the live host', async () => {
    const portal = makeFakePortal({
      email: EMAIL,
      passwordDigest: DIGEST,
      file: FILE,
      pendingPolls: 2,
    });
    const client = makeClient(portal);

    const token = await client.login(EMAIL, DIGEST);
    expect(token).toBe(PORTAL_TOKEN);

    const fromUtc = new Date('2026-09-07T17:00:00.000Z');
    const toUtc = new Date('2026-09-08T16:59:59.999Z');
    const reportId = await client.requestExport(token, fromUtc, toUtc);
    expect(reportId).toBe(PORTAL_REPORT_ID);

    const url = await client.waitForReport(token, reportId);
    expect(url).toBe(PORTAL_FILE_URL);

    const file = await client.download(token, url);
    expect(file.buffer.equals(FILE)).toBe(true);
    expect(file.filename).toBe(`${PORTAL_REPORT_ID}.csv`);

    const [login, exp, ...rest] = portal.calls;
    expect(login).toMatchObject({
      method: 'POST',
      url: `${PORTAL_BASE}auth/login`,
      body: { email: EMAIL, password: DIGEST },
    });
    expect(login!.headers['content-type']).toContain('application/json');
    expect(login!.headers.origin).toBe('https://fleetpartner.gojek.com');
    expect(exp).toMatchObject({
      method: 'POST',
      url: `${PORTAL_BASE}report/export`,
      body: {
        type: REPORT_TYPE_RECONCILIATION,
        date_from: '2026-09-07T17:00:00.000Z',
        date_to: '2026-09-08T16:59:59.999Z',
      },
    });
    expect(exp!.headers.authorization).toBe(`Bearer ${PORTAL_TOKEN}`);
    // 2 pending polls + 1 ready, then the download
    const polls = rest.filter((c) => c.url.startsWith(`${PORTAL_BASE}report/result`));
    expect(polls).toHaveLength(3);
    expect(rest.at(-1)).toMatchObject({ method: 'GET', url: PORTAL_FILE_URL });
    expect(rest.at(-1)!.headers.authorization).toBe(`Bearer ${PORTAL_TOKEN}`);
  });

  it('rejected login (success:false) → login_rejected with the portal reason', async () => {
    const portal = makeFakePortal({ email: EMAIL, passwordDigest: DIGEST, file: FILE });
    const client = makeClient(portal);
    const p = client.login(EMAIL, GojekFleetPartnerClient.passwordDigest('wrong'));
    await expectPortalError(p, 'login_rejected');
    await expect(p).rejects.toThrow(/Login portal Gojek ditolak — Email atau kata sandi salah/);
  });

  it('rejected login via HTTP 401 is still a credential problem, not an outage', async () => {
    const portal = makeFakePortal({
      email: EMAIL,
      passwordDigest: DIGEST,
      file: FILE,
      loginHttp401: true,
    });
    await expectPortalError(makeClient(portal).login(EMAIL, 'nope'), 'login_rejected');
  });

  it('expired token (HTTP 401 after login) → unauthorized', async () => {
    const portal = makeFakePortal({ email: EMAIL, passwordDigest: DIGEST, file: FILE });
    const client = makeClient(portal);
    const token = await client.login(EMAIL, DIGEST);
    portal.options.expiredToken = true;
    await expectPortalError(client.requestExport(token, new Date(), new Date()), 'unauthorized');
    await expectPortalError(client.download(token, PORTAL_FILE_URL), 'unauthorized');
  });

  it('portal-side report failure (data.msg) → report_failed', async () => {
    const portal = makeFakePortal({
      email: EMAIL,
      passwordDigest: DIGEST,
      file: FILE,
      reportFailure: 'Report generation failed',
    });
    const client = makeClient(portal);
    const p = client.waitForReport(PORTAL_TOKEN, PORTAL_REPORT_ID);
    await expectPortalError(p, 'report_failed');
    await expect(p).rejects.toThrow(/laporan #77: Report generation failed/);
  });

  it('a report that never becomes ready → report_timeout (unknown statuses keep waiting)', async () => {
    const portal = makeFakePortal({
      email: EMAIL,
      passwordDigest: DIGEST,
      file: FILE,
      pendingPolls: 1_000,
    });
    const client = new GojekFleetPartnerClient(
      { pollIntervalMs: 1, pollMaxMs: 5 },
      { fetch: portal.fetch, sleep: () => new Promise((r) => setTimeout(r, 2)) },
    );
    await expectPortalError(client.waitForReport(PORTAL_TOKEN, PORTAL_REPORT_ID), 'report_timeout');
  });

  it('network failure → unreachable with the underlying cause', async () => {
    const client = new GojekFleetPartnerClient(
      {},
      {
        fetch: () =>
          Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })),
        sleep: noSleep,
      },
    );
    const p = client.login(EMAIL, DIGEST);
    await expectPortalError(p, 'unreachable');
    await expect(p).rejects.toThrow(/ECONNREFUSED/);
  });

  it('non-JSON / 5xx answers → bad_response', async () => {
    const client = new GojekFleetPartnerClient(
      {},
      {
        fetch: () => Promise.resolve(new Response('<html>502</html>', { status: 502 })),
        sleep: noSleep,
      },
    );
    await expectPortalError(client.login(EMAIL, DIGEST), 'bad_response');
  });
});
