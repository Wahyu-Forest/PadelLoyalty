import { WEEKDAY_LABELS, weekdayOf } from "@padelloyalty/shared";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-12-01T09:00` → `Tue 1 Dec 2026, 09:00` (no time zone conversion). */
export function formatLocalDateTime(local: string): string {
  const [date = "", time = ""] = local.split("T");
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAY_LABELS[weekdayOf(date)].slice(0, 3);
  return `${weekday} ${day} ${MONTHS[month - 1]} ${year}, ${time}`;
}

/** Every IANA zone the browser knows, for the time zone picker. */
export function timeZoneOptions(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.("timeZone") ?? [];
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
}
