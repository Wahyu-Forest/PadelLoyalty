import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/auth/rate-limit.js";

describe("RateLimiter", () => {
  const rule = { max: 2, windowMs: 10_000 };

  it("allows up to max hits per window, then reports the seconds left", () => {
    let now = 0;
    const limiter = new RateLimiter({ loginPerIp: rule }, () => now);

    expect(limiter.consume("loginPerIp", "ip").limited).toBe(false);
    expect(limiter.consume("loginPerIp", "ip").limited).toBe(false);
    now = 2_500;
    expect(limiter.consume("loginPerIp", "ip")).toEqual({ limited: true, retryAfterSeconds: 8 });
  });

  it("starts a fresh window once the old one ends", () => {
    let now = 0;
    const limiter = new RateLimiter({ loginPerIp: rule }, () => now);
    limiter.consume("loginPerIp", "ip");
    limiter.consume("loginPerIp", "ip");
    now = 10_000;

    expect(limiter.consume("loginPerIp", "ip").limited).toBe(false);
  });

  it("keeps keys and rules apart", () => {
    const limiter = new RateLimiter({ loginPerIp: rule, signupPerIp: rule }, () => 0);
    limiter.consume("loginPerIp", "a");
    limiter.consume("loginPerIp", "a");

    expect(limiter.check("loginPerIp", "a").limited).toBe(true);
    expect(limiter.check("loginPerIp", "b").limited).toBe(false);
    expect(limiter.check("signupPerIp", "a").limited).toBe(false);
  });

  it("check does not count; reset clears", () => {
    const limiter = new RateLimiter({ loginPerIp: { max: 1, windowMs: 1_000 } }, () => 0);
    limiter.check("loginPerIp", "a");
    expect(limiter.check("loginPerIp", "a").limited).toBe(false);
    limiter.hit("loginPerIp", "a");
    expect(limiter.check("loginPerIp", "a").limited).toBe(true);
    limiter.reset("loginPerIp", "a");
    expect(limiter.check("loginPerIp", "a").limited).toBe(false);
  });

  it("never limits when disabled", () => {
    const limiter = new RateLimiter(false, () => 0);
    for (let i = 0; i < 100; i++) expect(limiter.consume("loginPerIp", "a").limited).toBe(false);
  });
});
