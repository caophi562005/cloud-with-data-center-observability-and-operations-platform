const DEFAULT_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

// No explicit timezone: Intl uses this user's browser/operating-system setting.
// Keep UTC ISO timestamps unchanged in API payloads and chart calculations.
export function createLocalDateTimeFormatter(
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_TIME_OPTIONS,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(undefined, options);
}

export function formatLocalDateTime(
  timestamp: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  return createLocalDateTimeFormatter(options).format(new Date(timestamp));
}

export function getBrowserTimeZone(): string {
  return createLocalDateTimeFormatter().resolvedOptions().timeZone;
}
