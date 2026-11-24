"use client";

import {
  COMMON_CURRENCIES,
  DEFAULT_CURRENCY,
  DEFAULT_TIME_ZONE,
  WEEKDAYS,
  WEEKDAY_LABELS,
  createClubRequestSchema,
  type Club,
  type CreateClubRequest,
  type OpeningHours,
  type Weekday,
} from "@padelloyalty/shared";
import { useId, useMemo, useState } from "react";
import { errorMessage, type ApiResult } from "@/lib/auth/api";
import { timeZoneOptions } from "@/lib/clubs/format";
import { Field, fieldErrorsFrom, FormError, Notice } from "../auth/Form";
import { quarterHourOptions, SelectField } from "./fields";

type DayState = { open: boolean; opens: string; closes: string };
type HoursState = Record<Weekday, DayState>;

const OPENS = quarterHourOptions(false);
const CLOSES = quarterHourOptions(true).slice(1);

export const DEFAULT_OPENING_HOURS: OpeningHours = {
  mon: { opens: "07:00", closes: "23:00" },
  tue: { opens: "07:00", closes: "23:00" },
  wed: { opens: "07:00", closes: "23:00" },
  thu: { opens: "07:00", closes: "23:00" },
  fri: { opens: "07:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "22:00" },
  sun: { opens: "08:00", closes: "22:00" },
};

function toState(hours: OpeningHours): HoursState {
  return Object.fromEntries(
    WEEKDAYS.map((day) => {
      const value = hours[day];
      return [
        day,
        value
          ? { open: true, opens: value.opens, closes: value.closes }
          : { open: false, opens: "09:00", closes: "21:00" },
      ];
    }),
  ) as HoursState;
}

function fromState(state: HoursState): OpeningHours {
  return Object.fromEntries(
    WEEKDAYS.map((day) => {
      const value = state[day];
      return [day, value.open ? { opens: value.opens, closes: value.closes } : null];
    }),
  ) as OpeningHours;
}

/**
 * Create a club, or edit an existing one's details and opening hours.
 * `submit` gets the whole club; for an edit the API takes it as a PATCH.
 */
export function ClubForm({
  club,
  currencyLocked = false,
  submitLabel,
  submit,
  onSaved,
}: {
  club?: Club;
  /** The club has prices: the currency can't change until they're removed. */
  currencyLocked?: boolean;
  submitLabel: string;
  submit: (body: CreateClubRequest) => Promise<ApiResult<{ club: Club }>>;
  onSaved: (club: Club) => void;
}) {
  const [name, setName] = useState(club?.name ?? "");
  const [address, setAddress] = useState(club?.address ?? "");
  const [timeZone, setTimeZone] = useState(club?.timeZone ?? DEFAULT_TIME_ZONE);
  const [currency, setCurrency] = useState(club?.currency ?? DEFAULT_CURRENCY);
  const [active, setActive] = useState(club?.active ?? true);
  const [hours, setHours] = useState<HoursState>(() =>
    toState(club?.openingHours ?? DEFAULT_OPENING_HOURS),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const zonesId = useId();
  const zones = useMemo(() => timeZoneOptions(), []);
  const currencies = useMemo(
    () =>
      (COMMON_CURRENCIES as readonly string[]).includes(currency)
        ? COMMON_CURRENCIES
        : [currency, ...COMMON_CURRENCIES],
    [currency],
  );

  const setDay = (day: Weekday, change: Partial<DayState>) =>
    setHours((current) => ({ ...current, [day]: { ...current[day], ...change } }));

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const body: CreateClubRequest = {
      name,
      address,
      timeZone,
      currency,
      active,
      openingHours: fromState(hours),
    };
    const parsed = createClubRequestSchema.safeParse(body);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    const result = await submit(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    setSaved(true);
    onSaved(result.data.club);
  }

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Club details">
      <FormError message={error} />
      {saved ? <Notice testId="club-saved">Saved.</Notice> : null}
      <Field
        label="Club name"
        name="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        errors={fieldErrors.name}
        required
      />
      <Field
        label="Address"
        name="address"
        autoComplete="street-address"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        errors={fieldErrors.address}
        required
      />
      <div className="grid-2">
        <Field
          label="Time zone"
          name="timeZone"
          list={zonesId}
          hint="IANA name, e.g. Europe/London. Hours, prices and blocks use this zone."
          value={timeZone}
          onChange={(e) => setTimeZone(e.target.value)}
          errors={fieldErrors.timeZone}
          autoComplete="off"
          required
        />
        <datalist id={zonesId}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <SelectField
          label="Currency"
          name="currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          disabled={currencyLocked}
          hint={currencyLocked ? "Remove this club's prices to change its currency." : undefined}
          errors={fieldErrors.currency}
          options={currencies.map((code) => ({ value: code, label: code }))}
        />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <span>Active (visible to members)</span>
      </label>

      <fieldset
        className="fieldset"
        aria-describedby={fieldErrors.openingHours ? "hours-error" : undefined}
      >
        <legend>Opening hours</legend>
        <div className="hours">
          {WEEKDAYS.map((day) => {
            const value = hours[day];
            return (
              <div className="hours-row" key={day} data-testid={`hours-${day}`}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={value.open}
                    onChange={(e) => setDay(day, { open: e.target.checked })}
                    aria-label={`Open on ${WEEKDAY_LABELS[day]}`}
                  />
                  <span>{WEEKDAY_LABELS[day]}</span>
                </label>
                {value.open ? (
                  <>
                    <select
                      aria-label={`${WEEKDAY_LABELS[day]} opens`}
                      value={value.opens}
                      onChange={(e) => setDay(day, { opens: e.target.value })}
                    >
                      {OPENS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <span aria-hidden="true">to</span>
                    <select
                      aria-label={`${WEEKDAY_LABELS[day]} closes`}
                      value={value.closes}
                      onChange={(e) => setDay(day, { closes: e.target.value })}
                    >
                      {CLOSES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="muted-inline">Closed</span>
                )}
              </div>
            );
          })}
        </div>
        {fieldErrors.openingHours ? (
          <p id="hours-error" className="field-error">
            {fieldErrors.openingHours.join(" ")}
          </p>
        ) : null}
      </fieldset>

      <div className="actions">
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
