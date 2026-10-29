/**
 * Strict RFC 3339 timestamps with an explicit zone, normalized to UTC and
 * written with exactly millisecond precision (`2026-10-21T12:00:00.000Z`).
 *
 * Instants are `Date`s (millisecond resolution, deterministic arithmetic from
 * parsed components; nothing relies on `Date.parse` normalizing bad input).
 * Finer fractions are truncated toward the earlier millisecond, as Python's
 * `isoformat(timespec="milliseconds")`. Supported range after normalization:
 * years 0001-9999 (Python's datetime range); inputs outside it are rejected,
 * as is year 0000. Python's non-RFC-3339 forms (space separator, basic
 * format, date-only) are rejected, as in Go.
 */
import { StorageCodecError } from "./errors.js";

const TIMESTAMP =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(Z|[+-][0-9]{2}:[0-9]{2})$/;

const MIN_MILLIS = utcMillis(1, 1, 1, 0, 0, 0, 0);
const MAX_MILLIS = utcMillis(9999, 12, 31, 23, 59, 59, 999);

function utcMillis(year: number, month: number, day: number, hour: number, minute: number, second: number, milli: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); // Date.UTC would map years 0-99 to 1900-1999
  date.setUTCHours(hour, minute, second, milli);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The instant, or `undefined` when the text is not an acceptable timestamp. */
export function parseTimestamp(text: string): Date | undefined {
  const match = TIMESTAMP.exec(text);
  if (match === null) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) {
    return undefined;
  }
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const zone = match[8] ?? "Z";
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return undefined;
    }
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }
  const milli = Number(`${match[7] ?? ""}000`.slice(0, 3));
  const instant = utcMillis(year, month, day, hour, minute, second, milli) - offsetMinutes * 60_000;
  return instant < MIN_MILLIS || instant > MAX_MILLIS ? undefined : new Date(instant);
}

/** Canonical text for a storable instant; throws a `value` error otherwise. */
export function formatTimestamp(instant: Date, field: string): string {
  const millis = instant instanceof Date ? instant.getTime() : Number.NaN;
  if (!Number.isFinite(millis) || millis < MIN_MILLIS || millis > MAX_MILLIS) {
    throw new StorageCodecError("value", `'${field}' must be a valid date between years 0001 and 9999`);
  }
  return new Date(millis).toISOString();
}
