/**
 * QA (Quan) tests for issue #6: points ledger and GET /points/balance.
 * Contract: docs/api/points.md, packages/shared/src/points.ts.
 *
 * Runs against the real test database (TEST_DATABASE_URL). Every test uses
 * fresh accounts with random emails, so nothing is truncated here.
 */
import { randomUUID } from "node:crypto";
import {
  POINTS_ENTRY_MAX_AMOUNT,
  POINTS_LEDGER_ERROR_CODES,
  pointsBalanceResponseSchema,
} from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import { LedgerError, PointsLedger } from "../src/points/ledger.js";
import {
  MINUTE,
  PASSWORD,
  activeMember,
  expectApiError,
  logIn,
  makeHarness,
  openTestDatabase,
  post,
  signUp,
  uniqueEmail,
  verify,
  type Harness,
} from "./support/auth-harness.js";

let connection: DatabaseConnection;
let h: Harness;
let ledger: PointsLedger;

beforeAll(async () => {
  connection = await openTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  h = await makeHarness(connection);
  ledger = new PointsLedger({ db: connection.db, now: h.clock.now });
});
afterEach(async () => {
  await h.app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBalance(token?: string, url = "/points/balance"): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function expectBalance(token: string, expected: number) {
  const response = await getBalance(token);
  expect(response.statusCode, response.body).toBe(200);
  const body = pointsBalanceResponseSchema.parse(response.json());
  expect(body.balance).toBe(expected);
  return body;
}

async function member() {
  const m = await activeMember(h);
  return { ...m, userId: m.session.user.id, token: m.session.accessToken };
}

const key = (tag = "qa") => `qa:${tag}:${randomUUID()}`;

function credit(userId: string, amount: number, idempotencyKey = key("credit"), extra = {}) {
  return ledger.credit({
    userId,
    amount,
    type: "earn",
    reason: "QA credit",
    idempotencyKey,
    actor: { type: "system" },
    ...extra,
  });
}

function debit(userId: string, amount: number, idempotencyKey = key("debit"), extra = {}) {
  return ledger.debit({
    userId,
    amount,
    type: "redeem",
    reason: "QA redeem",
    idempotencyKey,
    actor: { type: "member", userId },
    ...extra,
  });
}

/** Asserts that `promise` rejects with a LedgerError of `code`. */
async function expectLedgerError(promise: Promise<unknown>, code: string | string[]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected a LedgerError").toBeInstanceOf(LedgerError);
  const codes = Array.isArray(code) ? code : [code];
  expect(codes).toContain((error as LedgerError).code);
  expect(POINTS_LEDGER_ERROR_CODES).toContain((error as LedgerError).code);
}

async function sumInDb(userId: string): Promise<number> {
  const result = await connection.pool.query<{ total: string | null }>(
    "select sum(amount)::text as total from points_ledger_entries where user_id = $1",
    [userId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function countEntries(userId: string): Promise<number> {
  const result = await connection.pool.query<{ n: string }>(
    "select count(*)::text as n from points_ledger_entries where user_id = $1",
    [userId],
  );
  return Number(result.rows[0]!.n);
}

/** Runs raw SQL and returns the Postgres error, or undefined if it succeeded. */
async function sqlError(text: string, values: unknown[] = []): Promise<Error | undefined> {
  const client = await connection.pool.connect();
  try {
    await client.query("begin");
    await client.query(text, values);
    return undefined;
  } catch (error) {
    return error as Error;
  } finally {
    await client.query("rollback");
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GET /points/balance: access
// ---------------------------------------------------------------------------

describe("GET /points/balance access", () => {
  it("401 without a token, with a junk token and with an expired token", async () => {
    expectApiError(await getBalance(), 401, "unauthorized");
    expectApiError(await getBalance("pla_not-a-real-token"), 401, "unauthorized");
    const m = await member();
    h.clock.advance(16 * MINUTE);
    expectApiError(await getBalance(m.token), 401, "unauthorized");
  });

  it("401 after logout (revoked session)", async () => {
    const m = await member();
    const out = await post(h.app, "/auth/logout", { refreshToken: m.session.refreshToken });
    expect(out.statusCode, out.body).toBe(204);
    expectApiError(await getBalance(m.token), 401, "unauthorized");
  });

  it("403 account_not_active for an unverified (pending_verification) account", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    const session = await logIn(h, email);
    expect(session.user.status).toBe("pending_verification");
    expectApiError(await getBalance(session.accessToken), 403, "account_not_active");
  });

  it("403 account_not_active for an under-18 waiting for consent (pending_consent)", async () => {
    const email = uniqueEmail("kid");
    const response = await post(h.app, "/auth/signup", {
      email,
      password: PASSWORD,
      dateOfBirth: "2012-05-01",
      guardianEmail: uniqueEmail("guardian"),
    });
    expect(response.statusCode, response.body).toBe(202);
    await verify(h, email);
    const session = await logIn(h, email);
    expect(session.user.status).toBe("pending_consent");
    expectApiError(await getBalance(session.accessToken), 403, "account_not_active");
  });

  it("a pending member with ledger entries still gets 403, never the balance", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    const session = await logIn(h, email);
    await credit(session.user.id, 500);
    const response = await getBalance(session.accessToken);
    expectApiError(response, 403, "account_not_active");
    expect(response.body).not.toContain("500");
  });

  it("an active member with no entries sees 0, with asOf and no-store caching", async () => {
    const m = await member();
    const response = await getBalance(m.token);
    expect(response.statusCode, response.body).toBe(200);
    const body = pointsBalanceResponseSchema.parse(response.json());
    expect(body).toEqual({ balance: 0, asOf: expect.any(String) });
    expect(Object.keys(response.json() as object).sort()).toEqual(["asOf", "balance"]);
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it("asOf is the server clock at request time", async () => {
    const m = await member();
    h.clock.advance(5 * MINUTE);
    const body = await expectBalance(m.token, 0);
    expect(body.asOf).toBe(h.clock.now().toISOString());
  });

  it.each(["receptionist", "club_manager", "admin"])(
    "an active %s sees their own balance",
    async (role) => {
      const m = await member();
      await connection.pool.query("update users set role = $1 where id = $2", [role, m.userId]);
      await credit(m.userId, 42);
      await expectBalance(m.token, 42);
    },
  );
});

describe("GET /points/balance never exposes another member's balance", () => {
  it("query or path user ids are ignored or 404, never another member's balance", async () => {
    const alice = await member();
    const bob = await member();
    await credit(alice.userId, 111);
    await credit(bob.userId, 999);

    await expectBalance(alice.token, 111);
    await expectBalance(bob.token, 999);

    for (const url of [
      `/points/balance?userId=${bob.userId}`,
      `/points/balance?user_id=${bob.userId}`,
      `/points/balance?id=${bob.userId}`,
    ]) {
      const response = await getBalance(alice.token, url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      expect(pointsBalanceResponseSchema.parse(response.json()).balance, url).toBe(111);
    }
    for (const url of [`/points/balance/${bob.userId}`, `/points/${bob.userId}/balance`]) {
      const response = await getBalance(alice.token, url);
      expect(response.statusCode, `${url}: ${response.body}`).toBe(404);
      expect(response.body).not.toContain("999");
    }
  });
});

describe("no public write endpoint", () => {
  it.each([
    ["POST", "/points/balance"],
    ["PUT", "/points/balance"],
    ["PATCH", "/points/balance"],
    ["DELETE", "/points/balance"],
    ["POST", "/points"],
    ["POST", "/points/credit"],
    ["POST", "/points/debit"],
    ["POST", "/points/ledger"],
    ["POST", "/points/entries"],
    ["POST", "/points/earn"],
    ["POST", "/points/redeem"],
  ] as const)("%s %s is not routed (404/405)", async (method, url) => {
    const m = await member();
    const response = await h.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${m.token}` },
      payload: { amount: 1000, userId: m.userId, idempotencyKey: key() },
    });
    expect([404, 405], `${method} ${url}: ${response.body}`).toContain(response.statusCode);
    expect(await ledger.balance(m.userId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ledger service
// ---------------------------------------------------------------------------

describe("PointsLedger credit and debit", () => {
  it("app.pointsLedger is decorated on the app", () => {
    expect((h.app as unknown as { pointsLedger?: unknown }).pointsLedger).toBeInstanceOf(
      PointsLedger,
    );
  });

  it("credit stores a positive entry and returns the new balance", async () => {
    const m = await member();
    const k = key();
    const result = await credit(m.userId, 100, k, { reference: "booking:abc" });
    expect(result.created).toBe(true);
    expect(result.balance).toBe(100);
    expect(result.entry).toMatchObject({
      userId: m.userId,
      type: "earn",
      amount: 100,
      reason: "QA credit",
      reference: "booking:abc",
      idempotencyKey: k,
      actorType: "system",
      actorUserId: null,
    });
    await expectBalance(m.token, 100);
  });

  it("debit stores a negative entry with the member as actor", async () => {
    const m = await member();
    await credit(m.userId, 100);
    const result = await debit(m.userId, 30);
    expect(result.created).toBe(true);
    expect(result.entry.amount).toBe(-30);
    expect(result.entry.type).toBe("redeem");
    expect(result.entry.actorType).toBe("member");
    expect(result.entry.actorUserId).toBe(m.userId);
    expect(result.balance).toBe(70);
    await expectBalance(m.token, 70);
  });

  it("debit of exactly the balance leaves 0; one more point is insufficient_points", async () => {
    const m = await member();
    await credit(m.userId, 50);
    await expectLedgerError(debit(m.userId, 51), "insufficient_points");
    expect(await countEntries(m.userId)).toBe(1);
    expect(await ledger.balance(m.userId)).toBe(50);
    const ok = await debit(m.userId, 50);
    expect(ok.balance).toBe(0);
    await expectLedgerError(debit(m.userId, 1), "insufficient_points");
    await expectBalance(m.token, 0);
  });

  it("debit with no entries at all is insufficient_points", async () => {
    const m = await member();
    await expectLedgerError(debit(m.userId, 1), "insufficient_points");
    expect(await countEntries(m.userId)).toBe(0);
  });

  it("expiry and adjustment debits, staff adjustment credit", async () => {
    const m = await member();
    const staff = await member();
    await credit(m.userId, 200, key(), {
      type: "adjustment",
      actor: { type: "staff", userId: staff.userId },
    });
    await debit(m.userId, 20, key(), { type: "expiry", actor: { type: "system" } });
    const adj = await debit(m.userId, 30, key(), {
      type: "adjustment",
      actor: { type: "staff", userId: staff.userId },
    });
    expect(adj.entry).toMatchObject({ type: "adjustment", amount: -30, actorType: "staff" });
    expect(adj.entry.actorUserId).toBe(staff.userId);
    expect(adj.balance).toBe(150);
  });

  it("balance equals SUM(amount) after a mixed sequence", async () => {
    const m = await member();
    const ops: [string, number][] = [
      ["c", 500],
      ["d", 120],
      ["c", 75],
      ["d", 455],
      ["c", 1],
      ["c", 999],
      ["d", 1000],
    ];
    let expected = 0;
    for (const [op, n] of ops) {
      const r = op === "c" ? await credit(m.userId, n) : await debit(m.userId, n);
      expected += op === "c" ? n : -n;
      expect(r.balance).toBe(expected);
    }
    expect(await ledger.balance(m.userId)).toBe(expected);
    expect(await sumInDb(m.userId)).toBe(expected);
    await expectBalance(m.token, expected);
  });

  it("runs inside the caller's transaction: rollback leaves no entry", async () => {
    const m = await member();
    await expect(
      connection.db.transaction(async (tx) => {
        const r = await ledger.credit(
          {
            userId: m.userId,
            amount: 10,
            type: "earn",
            reason: "rolled back",
            idempotencyKey: key(),
            actor: { type: "system" },
          },
          tx,
        );
        expect(r.balance).toBe(10);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await countEntries(m.userId)).toBe(0);
    await expectBalance(m.token, 0);
  });
});

describe("PointsLedger validation", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fraction", 1.5],
    ["over the max", POINTS_ENTRY_MAX_AMOUNT + 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "100"],
  ])("credit and debit reject %s amounts with invalid_entry", async (_label, amount) => {
    const m = await member();
    await credit(m.userId, 1000);
    await expectLedgerError(credit(m.userId, amount as number), "invalid_entry");
    await expectLedgerError(debit(m.userId, amount as number), "invalid_entry");
    expect(await ledger.balance(m.userId)).toBe(1000);
  });

  it("accepts the max amount", async () => {
    const m = await member();
    const r = await credit(m.userId, POINTS_ENTRY_MAX_AMOUNT);
    expect(r.balance).toBe(POINTS_ENTRY_MAX_AMOUNT);
  });

  it.each([
    ["empty key", { idempotencyKey: "" }],
    ["key with a space", { idempotencyKey: "has space" }],
    ["key too long", { idempotencyKey: "k".repeat(201) }],
    ["non-ASCII key", { idempotencyKey: "clé:1" }],
    ["empty reason", { reason: "" }],
    ["blank reason", { reason: "   " }],
    ["reason too long", { reason: "r".repeat(501) }],
    ["debit type on credit", { type: "redeem" }],
    ["expiry type on credit", { type: "expiry" }],
    ["unknown type", { type: "bonus" }],
    ["staff actor without user", { actor: { type: "staff" } }],
    ["member actor without user", { actor: { type: "member" } }],
    ["unknown actor type", { actor: { type: "robot" } }],
  ])("credit rejects %s with invalid_entry", async (_label, extra) => {
    const m = await member();
    await expectLedgerError(credit(m.userId, 10, key(), extra), "invalid_entry");
    expect(await countEntries(m.userId)).toBe(0);
  });

  it("debit rejects the earn type", async () => {
    const m = await member();
    await credit(m.userId, 100);
    await expectLedgerError(debit(m.userId, 10, key(), { type: "earn" }), "invalid_entry");
    expect(await ledger.balance(m.userId)).toBe(100);
  });

  it("system actor with a user id is rejected (actor consistency)", async () => {
    const m = await member();
    await expectLedgerError(
      credit(m.userId, 10, key(), { actor: { type: "system", userId: m.userId } }),
      "invalid_entry",
    );
  });

  it("unknown member is member_not_found; a non-uuid id is a LedgerError, not a crash", async () => {
    await expectLedgerError(credit(randomUUID(), 10), "member_not_found");
    await expectLedgerError(credit("not-a-uuid", 10), ["invalid_entry", "member_not_found"]);
    await expectLedgerError(ledger.balance("not-a-uuid"), ["invalid_entry", "member_not_found"]);
  });

  it("balance of an unknown (uuid) member is 0 or member_not_found, never a crash", async () => {
    const result = await ledger.balance(randomUUID()).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if ("value" in result) expect(result.value).toBe(0);
    else expect(result.error).toBeInstanceOf(LedgerError);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency (no double credit)", () => {
  it("replaying the same credit returns the original entry and credits once", async () => {
    const m = await member();
    const k = key("checkin");
    const first = await credit(m.userId, 100, k);
    h.clock.advance(MINUTE);
    const second = await credit(m.userId, 100, k);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.createdAt).toEqual(first.entry.createdAt);
    expect(second.balance).toBe(100);
    expect(await countEntries(m.userId)).toBe(1);
    await expectBalance(m.token, 100);
  });

  it("replaying a debit after the points are spent is a replay, not insufficient_points", async () => {
    const m = await member();
    await credit(m.userId, 100);
    const k = key("redemption");
    const first = await debit(m.userId, 100, k);
    expect(first.balance).toBe(0);
    const again = await debit(m.userId, 100, k);
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe(first.entry.id);
    expect(again.balance).toBe(0);
    expect(await countEntries(m.userId)).toBe(2);
  });

  it.each([
    ["different amount", { amount: 101 }],
    ["different type", { type: "adjustment" }],
    ["different reference", { reference: "booking:other" }],
  ])("same key with a %s is idempotency_key_reused", async (_label, change) => {
    const m = await member();
    const k = key();
    await credit(m.userId, 100, k, { reference: "booking:one" });
    const { amount = 100, ...extra } = change as { amount?: number };
    await expectLedgerError(
      credit(m.userId, amount, k, { reference: "booking:one", ...extra }),
      "idempotency_key_reused",
    );
    expect(await ledger.balance(m.userId)).toBe(100);
  });

  it("same key for a different member is idempotency_key_reused", async () => {
    const a = await member();
    const b = await member();
    const k = key();
    await credit(a.userId, 100, k);
    await expectLedgerError(credit(b.userId, 100, k), "idempotency_key_reused");
    expect(await ledger.balance(b.userId)).toBe(0);
  });

  it("a credit key cannot be reused for a debit", async () => {
    const m = await member();
    const k = key();
    await credit(m.userId, 100, k);
    await expectLedgerError(debit(m.userId, 100, k), "idempotency_key_reused");
    expect(await ledger.balance(m.userId)).toBe(100);
  });

  it("20 concurrent credits with one key record exactly one entry", async () => {
    const m = await member();
    const k = key("race");
    const results = await Promise.all(Array.from({ length: 20 }, () => credit(m.userId, 250, k)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    expect(await countEntries(m.userId)).toBe(1);
    expect(await ledger.balance(m.userId)).toBe(250);
  });

  it("concurrent credits with one key for two different members: one wins, one is reused", async () => {
    const a = await member();
    const b = await member();
    const k = key("race2");
    const settled = await Promise.allSettled([credit(a.userId, 10, k), credit(b.userId, 10, k)]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const reason = (failed[0] as PromiseRejectedResult).reason as unknown;
    expect(reason).toBeInstanceOf(LedgerError);
    expect((reason as LedgerError).code).toBe("idempotency_key_reused");
    expect((await ledger.balance(a.userId)) + (await ledger.balance(b.userId))).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe("concurrent debits never overdraw", () => {
  it("10 parallel debits of 60 against 100: exactly one succeeds", async () => {
    const m = await member();
    await credit(m.userId, 100);
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => debit(m.userId, 60)));
    const ok = settled.filter((s) => s.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const s of settled) {
      if (s.status === "rejected") {
        expect(s.reason).toBeInstanceOf(LedgerError);
        expect((s.reason as LedgerError).code).toBe("insufficient_points");
      }
    }
    expect(await ledger.balance(m.userId)).toBe(40);
    expect(await sumInDb(m.userId)).toBe(40);
  });

  it("parallel debits of 10 against 95 leave exactly 5", async () => {
    const m = await member();
    await credit(m.userId, 95);
    const settled = await Promise.allSettled(Array.from({ length: 15 }, () => debit(m.userId, 10)));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(9);
    expect(await ledger.balance(m.userId)).toBe(5);
  });

  it("interleaved credits and debits keep the balance equal to the sum and never negative", async () => {
    const m = await member();
    await credit(m.userId, 50);
    const work = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? credit(m.userId, 20) : debit(m.userId, 25),
    );
    await Promise.allSettled(work);
    const balance = await ledger.balance(m.userId);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(await sumInDb(m.userId));
    // 50 + 10 credits of 20 = 250 at most; each successful debit took 25.
    const debits = await connection.pool.query<{ n: string }>(
      "select count(*)::text as n from points_ledger_entries where user_id = $1 and amount < 0",
      [m.userId],
    );
    expect(Number(debits.rows[0]!.n) * 25).toBeLessThanOrEqual(250);
  });

  it("debits for different members do not block each other", async () => {
    const members = await Promise.all([member(), member(), member()]);
    await Promise.all(members.map((m) => credit(m.userId, 10)));
    const results = await Promise.all(members.map((m) => debit(m.userId, 10)));
    expect(results.map((r) => r.balance)).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Database guarantees (direct SQL)
// ---------------------------------------------------------------------------

describe("ledger immutability and constraints in the database", () => {
  it("UPDATE of an entry is rejected", async () => {
    const m = await member();
    const { entry } = await credit(m.userId, 100);
    for (const statement of [
      "update points_ledger_entries set amount = 100000 where id = $1",
      "update points_ledger_entries set reason = 'edited' where id = $1",
      "update points_ledger_entries set user_id = user_id where id = $1",
    ]) {
      expect(await sqlError(statement, [entry.id]), statement).toBeDefined();
    }
    expect(await ledger.balance(m.userId)).toBe(100);
  });

  it("DELETE of an entry is rejected", async () => {
    const m = await member();
    const { entry } = await credit(m.userId, 100);
    expect(
      await sqlError("delete from points_ledger_entries where id = $1", [entry.id]),
    ).toBeDefined();
    expect(
      await sqlError("delete from points_ledger_entries where user_id = $1", [m.userId]),
    ).toBeDefined();
    expect(await countEntries(m.userId)).toBe(1);
  });

  it("deleting a user who has entries is refused", async () => {
    const m = await member();
    await credit(m.userId, 5);
    expect(await sqlError("delete from users where id = $1", [m.userId])).toBeDefined();
  });

  const insert = `insert into points_ledger_entries
      (user_id, entry_type, amount, reason, idempotency_key, actor_type, actor_user_id)
      values ($1, $2, $3, 'qa', $4, $5, $6)`;

  it.each([
    ["zero amount", "adjustment", 0, "system", false],
    ["negative earn", "earn", -10, "system", false],
    ["positive redeem", "redeem", 10, "member", true],
    ["positive expiry", "expiry", 10, "system", false],
    ["amount over max", "earn", POINTS_ENTRY_MAX_AMOUNT + 1, "system", false],
    ["system actor with user", "earn", 10, "system", true],
    ["staff actor without user", "adjustment", 10, "staff", false],
    ["unknown entry type", "bonus", 10, "system", false],
  ] as const)("check constraints reject %s", async (_label, type, amount, actor, withUser) => {
    const m = await member();
    const err = await sqlError(insert, [
      m.userId,
      type,
      amount,
      key(),
      actor,
      withUser ? m.userId : null,
    ]);
    expect(err).toBeDefined();
  });

  it("the unique idempotency key is enforced by the database", async () => {
    const m = await member();
    const { entry } = await credit(m.userId, 10);
    const err = await sqlError(insert, [
      m.userId,
      "earn",
      10,
      entry.idempotencyKey,
      "system",
      null,
    ]);
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("23505");
  });

  it("a valid direct insert works (control for the tests above)", async () => {
    const m = await member();
    expect(await sqlError(insert, [m.userId, "earn", 10, key(), "system", null])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Large numbers
// ---------------------------------------------------------------------------

describe("large balances", () => {
  it("a balance above 2^31 is returned exactly as a JSON integer", async () => {
    const m = await member();
    // 2,200 entries of 1,000,000 = 2.2 billion, beyond a 32-bit integer.
    await connection.pool.query(
      `insert into points_ledger_entries
         (user_id, entry_type, amount, reason, idempotency_key, actor_type)
       select $1, 'earn', 1000000, 'qa bulk', $2 || g, 'system'
         from generate_series(1, 2200) g`,
      [m.userId, key("bulk")],
    );
    const expected = 2_200_000_000;
    expect(await ledger.balance(m.userId)).toBe(expected);
    const response = await getBalance(m.token);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(`"balance":${expected}`);
    // Debits still work on a large balance.
    const r = await debit(m.userId, 1);
    expect(r.balance).toBe(expected - 1);
  });
});
