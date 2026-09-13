import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * HTTP client for the Gojek Fleet Partner Portal (https://fleetpartner.gojek.com).
 * It replays exactly what the browser does when Finance downloads the
 * "Transaction History for Reconciliation" report from the Reports menu:
 *
 *   POST auth/login    {email, password}               → data.token (JWT)
 *   POST report/export {type, date_from, date_to (UTC)} → data.report_id
 *   GET  report/result?report_id=…                     → data.status (3 = ready), data.path
 *   GET  <data.path>                                   → the spreadsheet
 *
 * The password is never sent raw: the portal sends base64(md5(password)) —
 * see passwordDigest(). Only that digest is ever stored (encrypted).
 *
 * This is NOT an official API. If Gojek changes the portal, this class is the
 * single place to adapt. Every failure surfaces as GojekPortalError with an
 * operator-friendly Indonesian message.
 */

export const GOJEK_PORTAL_DEFAULTS = {
  baseUrl: 'https://fleetpartner.gojek.com/api/api/v1/',
  origin: 'https://fleetpartner.gojek.com',
  /** One HTTP call (login/export/status). */
  requestTimeoutMs: 30_000,
  /** The report file download. */
  downloadTimeoutMs: 120_000,
  /** The portal builds the report asynchronously; its own UI polls every 1–2 s. */
  pollIntervalMs: 2_000,
  pollMaxMs: 180_000,
} as const;

export type GojekPortalClientOptions = typeof GOJEK_PORTAL_DEFAULTS;

/** "Transaction History for Reconciliation" — the format the Gojek parser reads. */
export const REPORT_TYPE_RECONCILIATION = 1;
/** report/result `data.status` when the file can be downloaded. */
export const REPORT_STATUS_READY = 3;

export type GojekPortalErrorKind =
  | 'unreachable' // network / timeout
  | 'login_rejected' // wrong email/password
  | 'unauthorized' // token expired / revoked (HTTP 401/403)
  | 'bad_response' // unexpected payload / HTTP status
  | 'report_failed' // portal reported an error building the report
  | 'report_timeout'; // still not ready after pollMaxMs

export class GojekPortalError extends Error {
  constructor(
    readonly kind: GojekPortalErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GojekPortalError';
  }
}

export interface ReportResult {
  status: number;
  path: string;
  msg: string;
}

export interface DownloadedReport {
  buffer: Buffer;
  /** Basename of the portal path, e.g. `report_123.xlsx` (empty when absent). */
  filename: string;
}

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

interface PortalEnvelope {
  success?: boolean;
  message?: unknown;
  msg?: unknown;
  error?: unknown;
  data?: Record<string, unknown> | null;
}

const ABSOLUTE_URL = /^https?:\/\//i;

@Injectable()
export class GojekFleetPartnerClient {
  private readonly options: GojekPortalClientOptions;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  /**
   * Every URL is built absolute from `options.baseUrl` (default: the live
   * portal), so a client constructed with no options — including the one Nest
   * builds through DI — still targets https://fleetpartner.gojek.com. Tests
   * inject a fake `fetch` and an instant `sleep`.
   */
  constructor(
    options: Partial<GojekPortalClientOptions> = {},
    deps: { fetch?: FetchLike; sleep?: Sleep } = {},
  ) {
    this.options = { ...GOJEK_PORTAL_DEFAULTS, ...stripUndefined(options) };
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** What the portal's login form actually sends: base64 of the md5 hex digest. */
  static passwordDigest(plainPassword: string): string {
    return Buffer.from(createHash('md5').update(plainPassword, 'utf8').digest('hex')).toString(
      'base64',
    );
  }

  /** Absolute portal URL for a relative endpoint; absolute inputs pass through. */
  resolveUrl(pathOrUrl: string): string {
    if (ABSOLUTE_URL.test(pathOrUrl)) return pathOrUrl;
    return this.options.baseUrl.replace(/\/+$/, '') + '/' + pathOrUrl.replace(/^\/+/, '');
  }

  /** @returns the Bearer token */
  async login(email: string, passwordDigest: string): Promise<string> {
    const body = await this.requestJson('POST', 'auth/login', {
      json: { email, password: passwordDigest },
      step: 'login',
      // A wrong password is the ONE case the portal answers with success:false
      // (and sometimes HTTP 401) — report it as a credential problem, not an outage.
      loginAttempt: true,
    });
    const token = typeof body.data?.token === 'string' ? body.data.token : '';
    if (!body.success || token === '') {
      throw new GojekPortalError(
        'login_rejected',
        `Login portal Gojek ditolak${reason(body)}. Periksa email & kata sandi akun portal.`,
      );
    }
    return token;
  }

  /** Ask the portal to build a report. Bounds are UTC instants (see utcBounds). */
  async requestExport(
    token: string,
    fromUtc: Date,
    toUtc: Date,
    type: number = REPORT_TYPE_RECONCILIATION,
  ): Promise<number> {
    const body = await this.requestJson('POST', 'report/export', {
      token,
      json: { type, date_from: formatUtc(fromUtc), date_to: formatUtc(toUtc) },
      step: 'permintaan export',
    });
    const reportId = firstPositiveInt(body.data, ['report_id', 'id']);
    if (!body.success || reportId === null) {
      throw new GojekPortalError(
        'bad_response',
        `Portal Gojek tidak mengembalikan ID laporan${reason(body)}.`,
      );
    }
    return reportId;
  }

  async reportResult(token: string, reportId: number): Promise<ReportResult> {
    const body = await this.requestJson('GET', `report/result?report_id=${reportId}`, {
      token,
      step: 'status laporan',
    });
    if (!body.success || !body.data || typeof body.data !== 'object') {
      throw new GojekPortalError(
        'bad_response',
        `Status laporan portal Gojek tidak terbaca${reason(body)}.`,
      );
    }
    const d = body.data;
    return {
      status: Number(d.status ?? 0) || 0,
      path: typeof d.path === 'string' ? d.path.trim() : '',
      msg: typeof d.msg === 'string' ? d.msg.trim() : '',
    };
  }

  /**
   * Poll until the report is downloadable. Any status other than READY is
   * treated as "still building" (the other codes are undocumented) until the
   * deadline; a non-empty `msg` means the portal gave up.
   * @returns absolute file URL (data.path)
   */
  async waitForReport(token: string, reportId: number): Promise<string> {
    const interval = Math.max(250, this.options.pollIntervalMs);
    const deadline = Date.now() + Math.max(interval, this.options.pollMaxMs);
    for (;;) {
      const result = await this.reportResult(token, reportId);
      if (result.status === REPORT_STATUS_READY && result.path !== '') return result.path;
      if (result.msg !== '') {
        throw new GojekPortalError(
          'report_failed',
          `Portal Gojek gagal menyusun laporan #${reportId}: ${result.msg}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new GojekPortalError(
          'report_timeout',
          `Laporan #${reportId} belum siap setelah ${Math.round(this.options.pollMaxMs / 1000)} detik (status ${result.status}). Coba lagi beberapa saat lagi.`,
        );
      }
      await this.sleep(interval);
    }
  }

  /** Download the finished report (data.path is absolute; relative is tolerated). */
  async download(token: string, pathOrUrl: string): Promise<DownloadedReport> {
    const url = this.resolveUrl(pathOrUrl);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: { ...this.defaultHeaders(), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.options.downloadTimeoutMs),
      });
    } catch (err) {
      throw new GojekPortalError(
        'unreachable',
        `Unduhan laporan dari portal Gojek gagal: ${errorMessage(err)}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new GojekPortalError(
        'unauthorized',
        `Portal Gojek menolak akses saat mengunduh laporan (HTTP ${res.status}).`,
      );
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (res.status >= 400 || buffer.length === 0) {
      throw new GojekPortalError(
        'bad_response',
        `Unduhan laporan dari portal Gojek gagal (HTTP ${res.status}, ${buffer.length} byte).`,
      );
    }
    return { buffer, filename: basename(url) };
  }

  /* ------------------------------------------------------------------ */

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; json?: unknown; step: string; loginAttempt?: boolean },
  ): Promise<PortalEnvelope> {
    const url = this.resolveUrl(path);
    const headers: Record<string, string> = { ...this.defaultHeaders() };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json;charset=UTF-8';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
    } catch (err) {
      throw new GojekPortalError(
        'unreachable',
        `Portal Gojek tidak bisa dihubungi saat ${opts.step}: ${errorMessage(err)}`,
      );
    }

    const text = await res.text();
    const body = parseJson(text);

    if (res.status === 401 || res.status === 403) {
      if (opts.loginAttempt) {
        throw new GojekPortalError(
          'login_rejected',
          `Login portal Gojek ditolak${reason(body)}. Periksa email & kata sandi akun portal.`,
        );
      }
      throw new GojekPortalError(
        'unauthorized',
        `Portal Gojek menolak akses saat ${opts.step} (HTTP ${res.status})${reason(body)}.`,
      );
    }
    if (res.status >= 400 || body === null) {
      throw new GojekPortalError(
        'bad_response',
        `Respons portal Gojek tidak dikenal saat ${opts.step} (HTTP ${res.status}).`,
      );
    }
    return body;
  }

  private defaultHeaders(): Record<string, string> {
    const origin = this.options.origin.replace(/\/+$/, '');
    return {
      Accept: 'application/json',
      Origin: origin,
      Referer: `${origin}/reports`,
      'User-Agent':
        'FleetTaxiDashboard/1.0 (+https://fleet-taxi.id; sinkronisasi laporan fleet partner)',
    };
  }
}

/** Portal timestamps look like `2026-09-08T17:00:00.000Z` (Date#toISOString). */
export function formatUtc(d: Date): string {
  return d.toISOString();
}

function parseJson(text: string): PortalEnvelope | null {
  if (!text.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function reason(body: PortalEnvelope | null): string {
  if (!body) return '';
  for (const key of ['message', 'msg', 'error'] as const) {
    const v = body[key];
    if (typeof v === 'string' && v.trim()) return ` — ${v.trim()}`;
  }
  const dataMsg = body.data?.msg;
  return typeof dataMsg === 'string' && dataMsg.trim() ? ` — ${dataMsg.trim()}` : '';
}

function firstPositiveInt(
  data: Record<string, unknown> | null | undefined,
  keys: string[],
): number | null {
  for (const key of keys) {
    const n = Number(data?.[key]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

function basename(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
  } catch {
    return '';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps the real cause (ECONNREFUSED, timeout) one level down
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return cause.message;
    return err.message;
  }
  return String(err);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
