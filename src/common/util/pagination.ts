export interface Pagination {
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * Parses and clamps `?page`/`?pageSize` query params. Shared by every
 * paginated list endpoint so the defaults and bounds live in one place.
 */
export function parsePagination(pageRaw: unknown, pageSizeRaw: unknown): Pagination {
  const page = Math.max(1, Number(pageRaw) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSizeRaw) || DEFAULT_PAGE_SIZE));
  return { page, pageSize };
}
