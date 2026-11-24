/**
 * Money (issue #56). Amounts are integers in the currency's minor unit
 * (pence for GBP, cents for EUR, yen for JPY) together with an ISO 4217
 * currency code. Never floats: parsing works on the decimal string, and only
 * display formatting divides.
 */

export const DEFAULT_CURRENCY = "GBP";

/** Currencies offered in the admin form. The API accepts any ISO 4217 code. */
export const COMMON_CURRENCIES = ["GBP", "EUR", "USD", "IDR", "SGD", "AED", "AUD"] as const;

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** True for a three-letter ISO 4217 code this runtime can format, e.g. `GBP`. */
export function isValidCurrency(value: string): boolean {
  if (!CURRENCY_CODE.test(value)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: value });
    return true;
  } catch {
    return false;
  }
}

/** Digits after the decimal point for a currency: 2 for GBP, 0 for JPY. */
export function minorUnitDigits(currency: string): number {
  return (
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** `"12.50"` → 1250 (GBP). Null when the text is not a plain non-negative amount. */
export function parseMoney(text: string, currency: string): number | null {
  const digits = minorUnitDigits(currency);
  const trimmed = text.trim();
  const pattern = digits > 0 ? new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${digits}}))?$`) : /^(\d{1,9})$/;
  const match = pattern.exec(trimmed);
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(digits, "0");
  return Number(`${match[1]}${fraction}`);
}

/** 1250 (GBP) → `"12.50"`, for editing in a text field. */
export function minorToDecimalString(amountMinor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  if (digits === 0) return String(amountMinor);
  const padded = String(amountMinor).padStart(digits + 1, "0");
  return `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

/** 1250 (GBP) → `"£12.50"`. */
export function formatMoney(amountMinor: number, currency: string, locale = "en-GB"): string {
  const digits = minorUnitDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(minorToDecimalString(amountMinor, currency)));
}
