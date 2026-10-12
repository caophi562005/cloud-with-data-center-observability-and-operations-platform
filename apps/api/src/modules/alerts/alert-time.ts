import { AlertInputError } from './alert.types.js';

/** Date is used only for calendar/offset arithmetic, never occurrence precision. */
export function normalizeAlertTime(input: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) throw new AlertInputError();
  const [, y, mo, d, h, mi, s, fraction = '', zone] = match;
  const year = Number(y), month = Number(mo), day = Number(d);
  const hour = Number(h), minute = Number(mi), second = Number(s);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) throw new AlertInputError();
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new AlertInputError();
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3)), offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59 || zone === '-00:00') throw new AlertInputError();
    const offset = (offsetHours * 60 + offsetMinutes) * (zone[0] === '+' ? 1 : -1);
    date.setTime(date.getTime() - offset * 60_000);
  }
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) throw new AlertInputError();
  return `${date.toISOString().slice(0, 19)}.${fraction.padEnd(9, '0')}Z`;
}
export function compareAlertTimes(left: string, right: string): -1 | 0 | 1 {
  const a = normalizeAlertTime(left), b = normalizeAlertTime(right);
  return a === b ? 0 : a < b ? -1 : 1;
}
