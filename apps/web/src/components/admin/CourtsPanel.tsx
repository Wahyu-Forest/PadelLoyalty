"use client";

import {
  createCourtRequestSchema,
  updateCourtRequestSchema,
  type Court,
  type CourtEnvironment,
} from "@padelloyalty/shared";
import { useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { Field, fieldErrorsFrom, FormError } from "../auth/Form";
import { SelectField } from "./fields";
import { useClubsApi } from "./useClubsApi";

const ENVIRONMENTS = [
  { value: "indoor", label: "Indoor" },
  { value: "outdoor", label: "Outdoor" },
] as const;

/** Add, rename, change indoor/outdoor, deactivate and reactivate courts. */
export function CourtsPanel({
  clubId,
  courts,
  onChanged,
}: {
  clubId: string;
  courts: Court[];
  onChanged: () => void;
}) {
  return (
    <div className="stack">
      <section className="card">
        <h2>Courts</h2>
        {courts.length === 0 ? (
          <p data-testid="no-courts">No courts yet. Add the first one below.</p>
        ) : (
          <ul className="plain-list" data-testid="court-list">
            {courts.map((court) => (
              <CourtRow
                key={`${court.id}-${court.updatedAt}`}
                clubId={clubId}
                court={court}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
        <p className="hint">
          Deactivating a court hides it from members and booking. Its history (blocks, and later
          bookings) is kept, and you can reactivate it at any time.
        </p>
      </section>
      <AddCourt clubId={clubId} onAdded={onChanged} />
    </div>
  );
}

function CourtRow({
  clubId,
  court,
  onChanged,
}: {
  clubId: string;
  court: Court;
  onChanged: () => void;
}) {
  const api = useClubsApi();
  const [name, setName] = useState(court.name);
  const [environment, setEnvironment] = useState<CourtEnvironment>(court.environment);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== court.name || environment !== court.environment;

  async function save(patch: { name?: string; environment?: CourtEnvironment; active?: boolean }) {
    setError(null);
    const parsed = updateCourtRequestSchema.safeParse(patch);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setBusy(true);
    const result = await api.updateCourt(clubId, court.id, parsed.data);
    setBusy(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    onChanged();
  }

  return (
    <li className="court-row" data-testid="court-row" data-court={court.name}>
      <form
        className="row"
        noValidate
        aria-label={`Court ${court.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          void save({ name, environment });
        }}
      >
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          errors={fieldErrors.name}
        />
        <SelectField
          label="Type"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value as CourtEnvironment)}
          options={ENVIRONMENTS}
          errors={fieldErrors.environment}
        />
        <div className="row-end">
          <span
            className="badge"
            data-tone={court.active ? "ok" : "off"}
            data-testid="court-status"
          >
            {court.active ? "Active" : "Inactive"}
          </span>
          {dirty ? (
            <button type="submit" disabled={busy}>
              Save
            </button>
          ) : null}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void save({ active: !court.active })}
          >
            {court.active ? "Deactivate" : "Reactivate"}
          </button>
        </div>
      </form>
      <FormError message={error} />
    </li>
  );
}

function AddCourt({ clubId, onAdded }: { clubId: string; onAdded: () => void }) {
  const api = useClubsApi();
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<CourtEnvironment>("indoor");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = createCourtRequestSchema.safeParse({ name, environment });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setBusy(true);
    const result = await api.createCourt(clubId, parsed.data);
    setBusy(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    setName("");
    onAdded();
  }

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Add a court">
      <h2>Add a court</h2>
      <FormError message={error} />
      <div className="grid-2">
        <Field
          label="Court name"
          name="courtName"
          placeholder="e.g. Court 3"
          value={name}
          onChange={(e) => setName(e.target.value)}
          errors={fieldErrors.name}
        />
        <SelectField
          label="Indoor or outdoor"
          name="environment"
          value={environment}
          onChange={(e) => setEnvironment(e.target.value as CourtEnvironment)}
          options={ENVIRONMENTS}
          errors={fieldErrors.environment}
        />
      </div>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? "Adding…" : "Add court"}
        </button>
      </div>
    </form>
  );
}
