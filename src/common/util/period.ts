import { BadRequestException } from '@nestjs/common';

/** Parses ?month&year query params (both required, month 1..12). */
export function parsePeriod(monthRaw: unknown, yearRaw: unknown): { month: number; year: number } {
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new BadRequestException('month must be an integer 1..12');
  }
  if (!Number.isInteger(year) || year < 2020 || year > 2099) {
    throw new BadRequestException('year must be an integer 2020..2099');
  }
  return { month, year };
}

export function toStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x as string | number));
  if (typeof v === 'string' && v !== '') return [v];
  if (typeof v === 'number') return [String(v)];
  return undefined;
}
