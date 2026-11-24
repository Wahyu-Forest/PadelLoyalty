/**
 * In-memory fixed-window rate limiter for the auth endpoints.
 *
 * Counters live in this process only: with several API instances each has its
 * own counters, so the effective limit multiplies. Move to Postgres or Redis
 * before running more than one instance.
 */

export interface RateLimitRule {
  max: number;
  windowMs: number;
}

export const RATE_LIMIT_RULE_NAMES = [
  "loginPerIp",
  "loginFailuresPerEmail",
  "signupPerIp",
  "emailRequestsPerIp",
  "emailRequestsPerEmail",
  "tokenAttemptsPerIp",
] as const;
export type RateLimitRuleName = (typeof RATE_LIMIT_RULE_NAMES)[number];
export type RateLimitRules = Record<RateLimitRuleName, RateLimitRule>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_RATE_LIMITS: RateLimitRules = {
  loginPerIp: { max: 30, windowMs: 15 * MINUTE },
  loginFailuresPerEmail: { max: 5, windowMs: 15 * MINUTE },
  signupPerIp: { max: 10, windowMs: HOUR },
  emailRequestsPerIp: { max: 20, windowMs: HOUR },
  emailRequestsPerEmail: { max: 3, windowMs: HOUR },
  tokenAttemptsPerIp: { max: 20, windowMs: 15 * MINUTE },
};

interface Window {
  count: number;
  resetAt: number;
}

export interface LimitCheck {
  limited: boolean;
  /** Seconds until the window resets (when limited). */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly rules: RateLimitRules | null;

  constructor(
    rules: Partial<RateLimitRules> | false = {},
    private readonly now: () => number = Date.now,
  ) {
    this.rules = rules === false ? null : { ...DEFAULT_RATE_LIMITS, ...rules };
  }

  /** Whether `key` is already at the limit, without counting a new hit. */
  check(rule: RateLimitRuleName, key: string): LimitCheck {
    const config = this.rules?.[rule];
    if (!config) return { limited: false, retryAfterSeconds: 0 };
    const window = this.current(rule, key);
    if (window && window.count >= config.max) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - this.now()) / 1000)),
      };
    }
    return { limited: false, retryAfterSeconds: 0 };
  }

  /** Counts one hit for `key`. */
  hit(rule: RateLimitRuleName, key: string): void {
    const config = this.rules?.[rule];
    if (!config) return;
    const id = `${rule}:${key}`;
    const window = this.current(rule, key);
    if (window) window.count += 1;
    else this.windows.set(id, { count: 1, resetAt: this.now() + config.windowMs });
    this.prune();
  }

  /** Checks the limit and, if not limited, counts the hit. */
  consume(rule: RateLimitRuleName, key: string): LimitCheck {
    const result = this.check(rule, key);
    if (!result.limited) this.hit(rule, key);
    return result;
  }

  reset(rule: RateLimitRuleName, key: string): void {
    this.windows.delete(`${rule}:${key}`);
  }

  private current(rule: RateLimitRuleName, key: string): Window | undefined {
    const id = `${rule}:${key}`;
    const window = this.windows.get(id);
    if (window && window.resetAt <= this.now()) {
      this.windows.delete(id);
      return undefined;
    }
    return window;
  }

  private lastPrune = 0;

  /** Drops expired windows now and then so memory stays bounded. */
  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < MINUTE && this.windows.size < 10_000) return;
    this.lastPrune = now;
    for (const [id, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(id);
    }
  }
}
