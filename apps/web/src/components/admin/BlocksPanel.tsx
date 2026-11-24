"use client";

import {
  COURT_BLOCK_REASONS,
  createCourtBlocksRequestSchemaIn,
  type Court,
  type CourtBlock,
  type CourtBlockReason,
} from "@padelloyalty/shared";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { formatLocalDateTime } from "@/lib/clubs/format";
import { Field, fieldErrorsFrom, FormError, Notice } from "../auth/Form";
import { SelectField } from "./fields";
import { useClubsApi } from "./useClubsApi";

const REASON_LABELS: Record<CourtBlockReason, string> = {
  maintenance: "Maintenance",
  event: "Event",
  other: "Other",
};

type BlocksState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; blocks: CourtBlock[] };

/** Block courts for maintenance or events, and see or remove upcoming blocks. */
export function BlocksPanel({
  clubId,
  timeZone,
  courts,
}: {
  clubId: string;
  timeZone: string;
  courts: Court[];
}) {
  const api = useClubsApi();
  const [state, setState] = useState<BlocksState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void api.listBlocks(clubId).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", blocks: result.data.blocks }
          : { status: "error", message: errorMessage(result.error) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, clubId, reloads]);

  const courtName = (id: string) => courts.find((c) => c.id === id)?.name ?? "Unknown court";

  return (
    <div className="stack">
      {courts.length === 0 ? (
        <Notice tone="warn">Add courts before blocking them.</Notice>
      ) : (
        <NewBlockForm clubId={clubId} timeZone={timeZone} courts={courts} onCreated={load} />
      )}
      <section className="card">
        <h2>Upcoming blocks</h2>
        {state.status === "loading" ? <p aria-busy="true">Loading blocks…</p> : null}
        {state.status === "error" ? <FormError message={state.message} /> : null}
        {state.status === "ready" && state.blocks.length === 0 ? (
          <p data-testid="no-blocks">No upcoming blocks.</p>
        ) : null}
        {state.status === "ready" && state.blocks.length > 0 ? (
          <div className="table-wrap">
            <table data-testid="block-list">
              <thead>
                <tr>
                  <th scope="col">Court</th>
                  <th scope="col">From</th>
                  <th scope="col">Until</th>
                  <th scope="col">Reason</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.blocks.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    court={courtName(block.courtId)}
                    onRemove={async () => {
                      const result = await api.cancelBlock(clubId, block.id);
                      if (!result.ok) {
                        setState({ status: "error", message: errorMessage(result.error) });
                        return;
                      }
                      load();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <p className="hint">Times are in the club&apos;s time zone ({timeZone}).</p>
      </section>
    </div>
  );
}

function BlockRow({
  block,
  court,
  onRemove,
}: {
  block: CourtBlock;
  court: string;
  onRemove: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <tr data-testid="block-row">
      <td>{court}</td>
      <td>{formatLocalDateTime(block.startsLocal)}</td>
      <td>{formatLocalDateTime(block.endsLocal)}</td>
      <td>
        {REASON_LABELS[block.reason]}
        {block.note ? <span className="muted-inline"> · {block.note}</span> : null}
      </td>
      <td>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          aria-label={`Remove block on ${court} from ${formatLocalDateTime(block.startsLocal)}`}
          onClick={async () => {
            setBusy(true);
            await onRemove();
            setBusy(false);
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function NewBlockForm({
  clubId,
  timeZone,
  courts,
  onCreated,
}: {
  clubId: string;
  timeZone: string;
  courts: Court[];
  onCreated: () => void;
}) {
  const api = useClubsApi();
  const [courtIds, setCourtIds] = useState<string[]>([]);
  const [startsLocal, setStartsLocal] = useState("");
  const [endsLocal, setEndsLocal] = useState("");
  const [reason, setReason] = useState<CourtBlockReason>("maintenance");
  const [note, setNote] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setCreated(null);
    const body = { courtIds, startsLocal, endsLocal, reason, note };
    const parsed = createCourtBlocksRequestSchemaIn(timeZone).safeParse(body);
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setBusy(true);
    const result = await api.createBlocks(clubId, body);
    setBusy(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    setCreated(result.data.blocks.length);
    setCourtIds([]);
    setNote("");
    onCreated();
  }

  const allSelected = courtIds.length === courts.length;

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Block courts">
      <h2>Block courts</h2>
      <p className="hint">
        Blocked courts can&apos;t be booked during the block. Times are in {timeZone}.
      </p>
      <FormError message={error} />
      {created ? (
        <Notice testId="block-created">
          {created === 1 ? "Court blocked." : `${created} courts blocked.`}
        </Notice>
      ) : null}
      <fieldset
        className="fieldset"
        aria-describedby={fieldErrors.courtIds ? "block-courts-error" : undefined}
      >
        <legend>Courts</legend>
        <div className="chips">
          {courts.map((court) => (
            <label className="chip" key={court.id}>
              <input
                type="checkbox"
                checked={courtIds.includes(court.id)}
                onChange={(e) =>
                  setCourtIds((current) =>
                    e.target.checked
                      ? [...current, court.id]
                      : current.filter((id) => id !== court.id),
                  )
                }
              />
              <span>
                {court.name}
                {court.active ? "" : " (inactive)"}
              </span>
            </label>
          ))}
        </div>
        <button
          type="button"
          className="link"
          onClick={() => setCourtIds(allSelected ? [] : courts.map((c) => c.id))}
        >
          {allSelected ? "Clear selection" : "Select all courts"}
        </button>
        {fieldErrors.courtIds ? (
          <p id="block-courts-error" className="field-error">
            {fieldErrors.courtIds.join(" ")}
          </p>
        ) : null}
      </fieldset>
      <div className="grid-2">
        <Field
          label="From"
          type="datetime-local"
          name="startsLocal"
          value={startsLocal}
          onChange={(e) => setStartsLocal(e.target.value)}
          errors={fieldErrors.startsLocal}
          required
        />
        <Field
          label="Until"
          type="datetime-local"
          name="endsLocal"
          value={endsLocal}
          onChange={(e) => setEndsLocal(e.target.value)}
          errors={fieldErrors.endsLocal}
          required
        />
      </div>
      <div className="grid-2">
        <SelectField
          label="Reason"
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value as CourtBlockReason)}
          options={COURT_BLOCK_REASONS.map((value) => ({ value, label: REASON_LABELS[value] }))}
          errors={fieldErrors.reason}
        />
        <Field
          label="Note (optional)"
          name="note"
          placeholder="e.g. Resurfacing, Christmas tournament"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          errors={fieldErrors.note}
        />
      </div>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? "Blocking…" : "Block courts"}
        </button>
      </div>
    </form>
  );
}
