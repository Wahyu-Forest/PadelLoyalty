import type { PointsBalanceResponse } from "@padelloyalty/shared";
import type { ApiResult, ClientError } from "../auth/api";

/**
 * What the home screen's balance shows (#6).
 *
 * - `loading`: first fetch, no balance yet.
 * - `loaded`: a balance from the API. While a refetch runs it stays on screen
 *   (`refreshing`); if the refetch fails, the last balance stays with
 *   `refreshError` set rather than disappearing.
 * - `error`: the first fetch failed; nothing to show but the error.
 */
export type BalanceState =
  | { status: "loading" }
  | {
      status: "loaded";
      balance: number;
      asOf: string;
      refreshing: boolean;
      refreshError: ClientError | null;
    }
  | { status: "error"; error: ClientError };

/** Fetches the balance; null when there is no session any more (nothing to show). */
export type FetchBalance = () => Promise<ApiResult<PointsBalanceResponse> | null>;

type Listener = (state: BalanceState) => void;

/**
 * Loads the balance and keeps it fresh. One request at a time: a `load()`
 * while one is in flight runs once more after it, so a change signalled
 * mid-request (e.g. right after an earn) is never missed, and bursts of
 * focus / visibility / change events cost at most one extra request.
 */
export class BalanceLoader {
  private state: BalanceState = { status: "loading" };
  private readonly listeners = new Set<Listener>();
  private inflight: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(
    private readonly fetchBalance: FetchBalance,
    /** Called with each API error, e.g. to resync the session on 401 / 403. */
    private readonly onError: (error: ClientError) => void = () => {},
  ) {}

  getState(): BalanceState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetch now (or right after the request in flight). Resolves when the balance is current. */
  load(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Stop updating listeners (component unmounted). */
  stop(): void {
    this.stopped = true;
    this.listeners.clear();
  }

  private async run(): Promise<void> {
    do {
      this.again = false;
      if (this.state.status === "loaded") this.setState({ ...this.state, refreshing: true });
      else this.setState({ status: "loading" });

      let result: ApiResult<PointsBalanceResponse> | null;
      try {
        result = await this.fetchBalance();
      } catch {
        result = {
          ok: false,
          error: { code: "internal_error", message: "Something went wrong. Please try again." },
        };
      }
      if (this.stopped) return;
      this.apply(result);
    } while (this.again && !this.stopped);
  }

  private apply(result: ApiResult<PointsBalanceResponse> | null): void {
    if (result === null) {
      // Logged out meanwhile; the account panel takes over.
      if (this.state.status === "loaded") this.setState({ ...this.state, refreshing: false });
      return;
    }
    if (result.ok) {
      this.setState({
        status: "loaded",
        balance: result.data.balance,
        asOf: result.data.asOf,
        refreshing: false,
        refreshError: null,
      });
      return;
    }
    this.onError(result.error);
    if (this.state.status === "loaded") {
      this.setState({ ...this.state, refreshing: false, refreshError: result.error });
    } else {
      this.setState({ status: "error", error: result.error });
    }
  }

  private setState(state: BalanceState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

/** A balance for display, grouped for the reader's locale, e.g. "1,250". */
export function formatPoints(balance: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(balance);
}
