/**
 * #6 Points balance and the points ledger, against the real test database.
 * Contract: docs/api/points.md.
 */
import {
  apiErrorResponseSchema,
  pointsBalanceResponseSchema,
  type ApiErrorCode,
  type PointsLedgerErrorCode,
} from "@padelloyalty/shared";
import { eq, sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import { pointsLedgerEntries, users } from "../src/db/schema.js";
import {
  LedgerError,
  PointsLedger,
  type CreditInput,
  type DebitInput,
} from "../src/points/ledger.js";
import {
  PASSWORD,
  buildAuthApp,
  connectTestDatabase,
  resetAuthTables,
  type TestApp,
} from "./support/auth-app.js";

let connection: DatabaseConnection;
let t: TestApp;
let ledger: PointsLedger;
let keyCounter = 0;

beforeAll(async () => {
  connection = await connectTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  await resetAuthTables(connection);
  t = await buildAuthApp(connection);
  ledger = new PointsLedger({ db: connection.db });
});
afterEach(async () => {
  await t.app.close();
});

const key = () => `test:${Date.now()}:${++keyCounter}`;

async function member(email = `m${++keyCounter}@example.com`) {
  const login = await t.signUpVerified(email);
  return { id: login.user.id, accessToken: login.accessToken, email };
}

function earn(userId: string, amount: number, extra: Partial<CreditInput> = {}): CreditInput {
  return {
    userId,
    amount,
    type: "earn",
    reason: "Check-in",
    idempotencyKey: key(),
    actor: { type: "system" },
    ...extra,
  };
}

function redeem(userId: string, amount: number, extra: Partial<DebitInput> = {}): DebitInput {
  return {
    userId,
    amount,
    type: "redeem",
    reason: "Free coffee",
    idempotencyKey: key(),
    actor: { type: "member", userId },
    ...extra,
  };
}

async function expectLedgerError(promise: Promise<unknown>, code: PointsLedgerErrorCode) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, `expected LedgerError ${code}`).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe(code);
}

async function rowsFor(userId: string) {
  return connection.db
    .select()
    .from(pointsLedgerEntries)
    .where(eq(pointsLedgerEntries.userId, userId));
}

/** The Postgres error a raw statement fails with (drizzle wraps it in `cause`). */
async function dbError(statement: Promise<unknown>): Promise<{ code?: string; message: string }> {
  const error = await statement.then(
    () => null,
    (e: unknown) => e as Error & { cause?: { code?: string; message: string } },
  );
  expect(error, "expected the statement to fail").not.toBeNull();
  const cause = error?.cause ?? error;
  return { code: (cause as { code?: string }).code, message: String(cause?.message) };
}

function getBalance(accessToken?: string) {
  return t.app.inject({
    method: "GET",
    url: "/points/balance",
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

function expectError(response: LightMyRequestResponse, status: number, code: ApiErrorCode) {
  expect(response.statusCode, response.body).toBe(status);
  expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe(code);
}

// ---------------------------------------------------------------------------
// Ledger service
// ---------------------------------------------------------------------------

describe("PointsLedger: credit, debit, balance", () => {
  it("has a zero balance with no entries", async () => {
    const m = await member();
    expect(await ledger.balance(m.id)).toBe(0);
    expect(await ledger.balance("00000000-0000-4000-8000-000000000000")).toBe(0);
  });

  it("credits and debits as signed entries; the balance is their sum", async () => {
    const m = await member();
    const credited = await ledger.credit(earn(m.id, 100, { reference: "booking:b1" }));
    expect(credited.created).toBe(true);
    expect(credited.balance).toBe(100);
    expect(credited.entry).toMatchObject({
      userId: m.id,
      type: "earn",
      amount: 100,
      reason: "Check-in",
      reference: "booking:b1",
      actorType: "system",
      actorUserId: null,
    });

    const debited = await ledger.debit(redeem(m.id, 30));
    expect(debited.entry.amount).toBe(-30);
    expect(debited.entry).toMatchObject({ type: "redeem", actorType: "member", actorUserId: m.id });
    expect(debited.balance).toBe(70);

    const staff = await member();
    await ledger.credit({
      ...earn(m.id, 5),
      type: "adjustment",
      reason: "Goodwill",
      actor: { type: "staff", userId: staff.id },
    });
    await ledger.debit({ ...redeem(m.id, 25), type: "expiry", actor: { type: "system" } });
    await ledger.debit({
      ...redeem(m.id, 10),
      type: "adjustment",
      actor: { type: "staff", userId: staff.id },
    });

    expect(await ledger.balance(m.id)).toBe(40);
    const rows = await rowsFor(m.id);
    expect(rows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([-30, -25, -10, 5, 100]);
    expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(40);
  });

  it("counts only the member's own entries", async () => {
    const a = await member();
    const b = await member();
    await ledger.credit(earn(a.id, 10));
    await ledger.credit(earn(b.id, 99));
    expect(await ledger.balance(a.id)).toBe(10);
    expect(await ledger.balance(b.id)).toBe(99);
  });

  it("refuses a debit larger than the balance and writes nothing", async () => {
    const m = await member();
    await ledger.credit(earn(m.id, 50));
    await expectLedgerError(ledger.debit(redeem(m.id, 51)), "insufficient_points");
    expect(await rowsFor(m.id)).toHaveLength(1);
    expect(await ledger.balance(m.id)).toBe(50);

    // Exactly the balance is fine, and leaves zero.
    expect((await ledger.debit(redeem(m.id, 50))).balance).toBe(0);
    await expectLedgerError(ledger.debit(redeem(m.id, 1)), "insufficient_points");
  });

  it("refuses an unknown member", async () => {
    await expectLedgerError(
      ledger.credit(earn("00000000-0000-4000-8000-000000000000", 10)),
      "member_not_found",
    );
    await expectLedgerError(ledger.credit(earn("not-a-uuid", 10)), "member_not_found");
  });

  it.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 1.5 }],
    ["too large amount", { amount: 1_000_001 }],
    ["NaN amount", { amount: Number.NaN }],
    ["empty reason", { reason: "   " }],
    ["long reason", { reason: "x".repeat(501) }],
    ["empty key", { idempotencyKey: "" }],
    ["key with spaces", { idempotencyKey: "a b" }],
    ["long key", { idempotencyKey: "k".repeat(201) }],
    ["empty reference", { reference: "  " }],
    ["staff actor without user", { actor: { type: "staff" } }],
    ["unknown actor", { actor: { type: "robot" } }],
  ])("refuses an invalid credit: %s", async (_name, change) => {
    const m = await member();
    await expectLedgerError(
      ledger.credit({ ...earn(m.id, 10), ...(change as Partial<CreditInput>) }),
      "invalid_entry",
    );
    expect(await rowsFor(m.id)).toHaveLength(0);
  });

  it("refuses entry types on the wrong side", async () => {
    const m = await member();
    await ledger.credit(earn(m.id, 100));
    await expectLedgerError(
      ledger.credit({ ...earn(m.id, 10), type: "redeem" as never }),
      "invalid_entry",
    );
    await expectLedgerError(
      ledger.credit({ ...earn(m.id, 10), type: "expiry" as never }),
      "invalid_entry",
    );
    await expectLedgerError(
      ledger.debit({ ...redeem(m.id, 10), type: "earn" as never }),
      "invalid_entry",
    );
    expect(await ledger.balance(m.id)).toBe(100);
  });

  it("writes inside the caller's transaction, and rolls back with it", async () => {
    const m = await member();
    await connection.db
      .transaction(async (tx) => {
        const result = await ledger.credit(earn(m.id, 10), tx);
        expect(result.balance).toBe(10);
        expect(await ledger.balance(m.id, tx)).toBe(10);
        throw new Error("rollback");
      })
      .catch(() => {});
    expect(await ledger.balance(m.id)).toBe(0);
    expect(await rowsFor(m.id)).toHaveLength(0);
  });
});

describe("PointsLedger: no double counting (idempotency)", () => {
  it("records a key once; a replay returns the original entry", async () => {
    const m = await member();
    const input = earn(m.id, 100, { idempotencyKey: "checkin:booking-1:member-1" });
    const first = await ledger.credit(input);
    const again = await ledger.credit({ ...input, reason: "Check-in (retried)" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.entry).toEqual(first.entry);
    expect(again.balance).toBe(100);
    expect(await rowsFor(m.id)).toHaveLength(1);
  });

  it("replays a debit without checking the balance again", async () => {
    const m = await member();
    await ledger.credit(earn(m.id, 50));
    const input = redeem(m.id, 50);
    await ledger.debit(input);
    const again = await ledger.debit(input);
    expect(again.created).toBe(false);
    expect(again.balance).toBe(0);
  });

  it("refuses a key already used for a different entry", async () => {
    const a = await member();
    const b = await member();
    const input = earn(a.id, 100);
    await ledger.credit(input);
    await expectLedgerError(ledger.credit({ ...input, amount: 101 }), "idempotency_key_reused");
    await expectLedgerError(ledger.credit({ ...input, userId: b.id }), "idempotency_key_reused");
    await expectLedgerError(
      ledger.credit({ ...input, type: "adjustment" }),
      "idempotency_key_reused",
    );
    await expectLedgerError(
      ledger.credit({ ...input, reference: "booking:other" }),
      "idempotency_key_reused",
    );
    await expectLedgerError(
      ledger.debit({ ...redeem(a.id, 100), idempotencyKey: input.idempotencyKey }),
      "idempotency_key_reused",
    );
    expect(await ledger.balance(a.id)).toBe(100);
    expect(await ledger.balance(b.id)).toBe(0);
  });

  it("records a key once when the same event arrives many times at once", async () => {
    const m = await member();
    const input = earn(m.id, 25);
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.credit(input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    expect(await ledger.balance(m.id)).toBe(25);
  });

  it("records a key once when two members race for it", async () => {
    const a = await member();
    const b = await member();
    const k = key();
    const settled = await Promise.allSettled([
      ledger.credit(earn(a.id, 10, { idempotencyKey: k })),
      ledger.credit(earn(b.id, 10, { idempotencyKey: k })),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(LedgerError);
    expect(((rejected as PromiseRejectedResult).reason as LedgerError).code).toBe(
      "idempotency_key_reused",
    );
    expect((await ledger.balance(a.id)) + (await ledger.balance(b.id))).toBe(10);
  });

  it("the database refuses a duplicate key even without the service", async () => {
    const m = await member();
    const input = earn(m.id, 10);
    await ledger.credit(input);
    const error = await dbError(
      connection.db.execute(sql`
        insert into points_ledger_entries (user_id, entry_type, amount, reason, idempotency_key, actor_type)
        values (${m.id}, 'earn', 10, 'dup', ${input.idempotencyKey}, 'system')`),
    );
    expect(error.code).toBe("23505"); // unique_violation
  });
});

describe("PointsLedger: concurrency", () => {
  it("racing debits never overdraw the balance", async () => {
    const m = await member();
    await ledger.credit(earn(m.id, 100));
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => ledger.debit(redeem(m.id, 30))),
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(7);
    for (const f of failed) expect((f.reason as LedgerError).code).toBe("insufficient_points");
    expect(await ledger.balance(m.id)).toBe(10);
  });

  it("racing credits and debits add up exactly", async () => {
    const m = await member();
    await ledger.credit(earn(m.id, 10));
    await Promise.all([
      ...Array.from({ length: 10 }, () => ledger.credit(earn(m.id, 7))),
      ...Array.from({ length: 5 }, () => ledger.debit(redeem(m.id, 2))),
    ]);
    expect(await ledger.balance(m.id)).toBe(10 + 70 - 10);
  });
});

describe("points_ledger_entries is append-only in the database", () => {
  it("rejects UPDATE, DELETE and TRUNCATE", async () => {
    const m = await member();
    const { entry } = await ledger.credit(earn(m.id, 100));

    const update = await dbError(
      connection.db.execute(
        sql`update points_ledger_entries set amount = 1000000 where id = ${entry.id}`,
      ),
    );
    expect(update.message).toMatch(/append-only: UPDATE/);
    const del = await dbError(
      connection.db.execute(sql`delete from points_ledger_entries where id = ${entry.id}`),
    );
    expect(del.message).toMatch(/append-only: DELETE/);
    const truncate = await dbError(connection.db.execute(sql`truncate points_ledger_entries`));
    expect(truncate.message).toMatch(/append-only: TRUNCATE/);

    const [row] = await rowsFor(m.id);
    expect(row?.amount).toBe(100);
  });

  it("refuses to delete a member who has entries", async () => {
    const m = await member();
    await ledger.credit(earn(m.id, 1));
    const error = await dbError(connection.db.delete(users).where(eq(users.id, m.id)));
    expect(error.code).toBe("23503"); // foreign_key_violation
  });

  it.each([
    ["a zero amount", "earn", 0, "system", null],
    ["a negative earn", "earn", -5, "system", null],
    ["a positive redeem", "redeem", 5, "system", null],
    ["a positive expiry", "expiry", 5, "system", null],
    ["an amount over the maximum", "adjustment", 1_000_001, "system", null],
    ["a staff actor without a user", "adjustment", 5, "staff", null],
    ["a system actor with a user", "earn", 5, "system", "self"],
  ])("check constraints refuse %s", async (_name, type, amount, actorType, actor) => {
    const m = await member();
    const actorId = actor === "self" ? m.id : null;
    const error = await dbError(
      connection.db.execute(sql`
        insert into points_ledger_entries (user_id, entry_type, amount, reason, idempotency_key, actor_type, actor_user_id)
        values (${m.id}, ${type}, ${amount}, 'raw', ${key()}, ${actorType}, ${actorId})`),
    );
    expect(error.code).toBe("23514"); // check_violation
  });
});

// ---------------------------------------------------------------------------
// GET /points/balance
// ---------------------------------------------------------------------------

describe("GET /points/balance", () => {
  it("needs a logged-in user", async () => {
    expectError(await getBalance(), 401, "unauthorized");
    expectError(await getBalance("pla_not-a-real-token"), 401, "unauthorized");
  });

  it("refuses accounts that are not fully active", async () => {
    const email = "unverified@example.com";
    await t.post("/auth/signup", { email, password: PASSWORD });
    const login = (await t.post("/auth/login", { email, password: PASSWORD })).json() as {
      accessToken: string;
      user: { id: string };
    };
    expectError(await getBalance(login.accessToken), 403, "account_not_active");

    await connection.db
      .update(users)
      .set({ status: "pending_consent" })
      .where(eq(users.id, login.user.id));
    const response = await getBalance(login.accessToken);
    expectError(response, 403, "account_not_active");
    expect(apiErrorResponseSchema.parse(response.json()).error.message).toMatch(/guardian/);
  });

  it("returns 0 for an active member with no entries", async () => {
    const m = await member();
    const response = await getBalance(m.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = pointsBalanceResponseSchema.parse(response.json());
    expect(body.balance).toBe(0);
    expect(Date.parse(body.asOf)).toBe(t.clock.current.getTime());
  });

  it("returns the sum of the member's own entries, up to date after each earn or redeem", async () => {
    const m = await member();
    const other = await member();
    await ledger.credit(earn(other.id, 500));

    const balance = async () =>
      pointsBalanceResponseSchema.parse((await getBalance(m.accessToken)).json()).balance;

    await ledger.credit(earn(m.id, 120));
    expect(await balance()).toBe(120);
    await ledger.debit(redeem(m.id, 20));
    expect(await balance()).toBe(100);
    await t.app.pointsLedger!.credit(earn(m.id, 1));
    expect(await balance()).toBe(101);
  });

  it("is read-only: no write method on the points routes", async () => {
    const m = await member();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await t.app.inject({
        method,
        url: "/points/balance",
        headers: { authorization: `Bearer ${m.accessToken}` },
        payload: { balance: 1_000 },
      });
      expect(response.statusCode).toBe(404);
    }
    expect(await ledger.balance(m.id)).toBe(0);
  });
});
