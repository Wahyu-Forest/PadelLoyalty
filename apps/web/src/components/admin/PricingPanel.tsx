"use client";

import {
  MAX_SLOT_LENGTHS,
  SLOT_LENGTH_MAX_MINUTES,
  SLOT_LENGTH_MIN_MINUTES,
  TIME_STEP_MINUTES,
  WEEKDAYS,
  WEEKDAY_LABELS,
  clubPricingSchema,
  formatMoney,
  minorToDecimalString,
  parseMoney,
  type ClubPricing,
  type ClubPricingInput,
  type SlotPrice,
  type Weekday,
} from "@padelloyalty/shared";
import { useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { Notice } from "../auth/Form";
import { ErrorList, quarterHourOptions } from "./fields";
import { useClubsApi } from "./useClubsApi";

const SLOT_CHOICES: number[] = [];
for (let m = SLOT_LENGTH_MIN_MINUTES; m <= SLOT_LENGTH_MAX_MINUTES; m += TIME_STEP_MINUTES) {
  SLOT_CHOICES.push(m);
}
const STARTS = quarterHourOptions(false);
const ENDS = quarterHourOptions(true).slice(1);

/** Prices as typed (decimal text), keyed by slot length. */
type PriceText = Record<number, string>;

interface BandState {
  key: number;
  label: string;
  days: Weekday[];
  starts: string;
  ends: string;
  prices: PriceText;
}

let nextKey = 1;

function priceText(prices: SlotPrice[], currency: string): PriceText {
  return Object.fromEntries(
    prices.map((p) => [p.minutes, minorToDecimalString(p.amountMinor, currency)]),
  );
}

function slotLabel(minutes: number) {
  return `${minutes} min`;
}

/** Slot lengths, standard (off-peak) prices and peak bands for one club. */
export function PricingPanel({
  clubId,
  currency,
  pricing,
  onChanged,
}: {
  clubId: string;
  currency: string;
  pricing: ClubPricing | null;
  onChanged: () => void;
}) {
  const api = useClubsApi();
  const [lengths, setLengths] = useState<number[]>(pricing?.slotLengthsMinutes ?? [60, 90]);
  const [standard, setStandard] = useState<PriceText>(() =>
    pricing ? priceText(pricing.standardPrices, currency) : {},
  );
  const [bands, setBands] = useState<BandState[]>(() =>
    (pricing?.bands ?? []).map((band) => ({
      key: nextKey++,
      label: band.label,
      days: band.days,
      starts: band.starts,
      ends: band.ends,
      prices: priceText(band.prices, currency),
    })),
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const sortedLengths = [...lengths].sort((a, b) => a - b);

  const toggleLength = (minutes: number) =>
    setLengths((current) =>
      current.includes(minutes) ? current.filter((m) => m !== minutes) : [...current, minutes],
    );

  const updateBand = (key: number, change: Partial<BandState>) =>
    setBands((current) => current.map((b) => (b.key === key ? { ...b, ...change } : b)));

  /** Converts typed prices to minor units; collects messages for unreadable ones. */
  function toPrices(text: PriceText, owner: string, problems: string[]): SlotPrice[] {
    return sortedLengths.map((minutes) => {
      const raw = text[minutes] ?? "";
      const amountMinor = parseMoney(raw, currency);
      if (amountMinor === null) {
        problems.push(
          raw.trim() === ""
            ? `${owner}: enter a price for ${slotLabel(minutes)}`
            : `${owner}: "${raw}" is not a price for ${slotLabel(minutes)} (e.g. ${minorToDecimalString(3000, currency)})`,
        );
      }
      return { minutes, amountMinor: amountMinor ?? 0 };
    });
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setSaved(false);
    const problems: string[] = [];
    const body: ClubPricingInput = {
      slotLengthsMinutes: sortedLengths,
      standardPrices: toPrices(standard, "Standard price", problems),
      bands: bands.map((band) => ({
        label: band.label,
        days: band.days,
        starts: band.starts,
        ends: band.ends,
        prices: toPrices(band.prices, `Band "${band.label || "unnamed"}"`, problems),
      })),
    };
    const parsed = clubPricingSchema.safeParse(body);
    if (!parsed.success) problems.push(...parsed.error.issues.map((issue) => issue.message));
    if (problems.length > 0) {
      setErrors([...new Set(problems)]);
      return;
    }
    setErrors([]);
    setBusy(true);
    const result = await api.setPricing(clubId, body);
    setBusy(false);
    if (!result.ok) {
      const fieldMessages = Object.values(result.error.fieldErrors ?? {}).flat();
      setErrors(fieldMessages.length > 0 ? fieldMessages : [errorMessage(result.error)]);
      return;
    }
    setSaved(true);
    onChanged();
  }

  async function onRemove() {
    setBusy(true);
    const result = await api.clearPricing(clubId);
    setBusy(false);
    setConfirmRemove(false);
    if (!result.ok) {
      setErrors([errorMessage(result.error)]);
      return;
    }
    onChanged();
  }

  const priceInputs = (text: PriceText, onChange: (next: PriceText) => void, owner: string) => (
    <div className="price-grid">
      {sortedLengths.map((minutes) => (
        <label className="field" key={minutes}>
          <span className="field-label">
            {slotLabel(minutes)} ({currency})
          </span>
          <input
            inputMode="decimal"
            aria-label={`${owner} price for ${slotLabel(minutes)}`}
            value={text[minutes] ?? ""}
            placeholder={minorToDecimalString(0, currency)}
            onChange={(e) => onChange({ ...text, [minutes]: e.target.value })}
          />
        </label>
      ))}
    </div>
  );

  return (
    <form className="stack" onSubmit={onSave} noValidate aria-label="Slot lengths and prices">
      {pricing ? null : (
        <Notice tone="warn" testId="no-pricing">
          No prices yet: members can&apos;t book this club until prices are saved.
        </Notice>
      )}
      <ErrorList messages={errors} testId="pricing-errors" />
      {saved ? <Notice testId="pricing-saved">Prices saved.</Notice> : null}

      <fieldset className="card fieldset">
        <legend>Slot lengths</legend>
        <p className="hint">The booking lengths members can choose (up to {MAX_SLOT_LENGTHS}).</p>
        <div className="chips">
          {SLOT_CHOICES.map((minutes) => (
            <label className="chip" key={minutes}>
              <input
                type="checkbox"
                checked={lengths.includes(minutes)}
                onChange={() => toggleLength(minutes)}
              />
              <span>{slotLabel(minutes)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="card fieldset">
        <legend>Standard (off-peak) prices</legend>
        <p className="hint">
          Price per slot, used whenever no peak band applies, so every opening hour has a price.
        </p>
        {priceInputs(standard, setStandard, "Standard")}
      </fieldset>

      {bands.map((band, index) => (
        <fieldset className="card fieldset" key={band.key} data-testid="price-band">
          <legend>Peak band {index + 1}</legend>
          <div className="grid-3">
            <label className="field">
              <span className="field-label">Name</span>
              <input
                value={band.label}
                aria-label={`Band ${index + 1} name`}
                onChange={(e) => updateBand(band.key, { label: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">From</span>
              <select
                value={band.starts}
                aria-label={`Band ${index + 1} from`}
                onChange={(e) => updateBand(band.key, { starts: e.target.value })}
              >
                {STARTS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Until</span>
              <select
                value={band.ends}
                aria-label={`Band ${index + 1} until`}
                onChange={(e) => updateBand(band.key, { ends: e.target.value })}
              >
                {ENDS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="chips" role="group" aria-label={`Band ${index + 1} days`}>
            {WEEKDAYS.map((day) => (
              <label className="chip" key={day}>
                <input
                  type="checkbox"
                  checked={band.days.includes(day)}
                  onChange={(e) =>
                    updateBand(band.key, {
                      days: e.target.checked
                        ? [...band.days, day]
                        : band.days.filter((d) => d !== day),
                    })
                  }
                />
                <span>{WEEKDAY_LABELS[day].slice(0, 3)}</span>
              </label>
            ))}
          </div>
          {priceInputs(
            band.prices,
            (prices) => updateBand(band.key, { prices }),
            `Band ${index + 1}`,
          )}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setBands((current) => current.filter((b) => b.key !== band.key))}
            >
              Remove band
            </button>
          </div>
        </fieldset>
      ))}

      <p className="hint">
        A slot&apos;s price is set by its start time: a slot that starts inside a peak band costs
        the peak price. Bands can&apos;t overlap.
      </p>

      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() =>
            setBands((current) => [
              ...current,
              {
                key: nextKey++,
                label: "Peak",
                days: ["mon", "tue", "wed", "thu", "fri"],
                starts: "17:00",
                ends: "22:00",
                prices: {},
              },
            ])
          }
        >
          Add peak band
        </button>
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save prices"}
        </button>
      </div>

      {pricing ? (
        <section className="card">
          <h2>Current prices</h2>
          <PricingSummary pricing={pricing} currency={currency} />
          <div className="actions">
            {confirmRemove ? (
              <>
                <button type="button" disabled={busy} onClick={() => void onRemove()}>
                  Yes, remove all prices
                </button>
                <button type="button" className="secondary" onClick={() => setConfirmRemove(false)}>
                  Keep prices
                </button>
              </>
            ) : (
              <button type="button" className="secondary" onClick={() => setConfirmRemove(true)}>
                Remove prices
              </button>
            )}
          </div>
          <p className="hint">
            Removing prices makes the club unbookable until new prices are saved. It is also how to
            change the club&apos;s currency.
          </p>
        </section>
      ) : null}
    </form>
  );
}

function PricingSummary({ pricing, currency }: { pricing: ClubPricing; currency: string }) {
  return (
    <div className="table-wrap">
      <table data-testid="pricing-summary">
        <thead>
          <tr>
            <th scope="col">Band</th>
            <th scope="col">When</th>
            {pricing.slotLengthsMinutes.map((m) => (
              <th scope="col" key={m}>
                {slotLabel(m)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Standard</th>
            <td>Any other time</td>
            {pricing.standardPrices.map((p) => (
              <td key={p.minutes}>{formatMoney(p.amountMinor, currency)}</td>
            ))}
          </tr>
          {pricing.bands.map((band) => (
            <tr key={`${band.label}-${band.starts}-${band.days.join()}`}>
              <th scope="row">{band.label}</th>
              <td>
                {band.days.map((d) => WEEKDAY_LABELS[d].slice(0, 3)).join(", ")} {band.starts}–
                {band.ends}
              </td>
              {band.prices.map((p) => (
                <td key={p.minutes}>{formatMoney(p.amountMinor, currency)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
