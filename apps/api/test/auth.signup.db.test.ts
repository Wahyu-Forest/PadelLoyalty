/**
 * #1 AC: "Member can sign up with email and password (password rules enforced,
 * passwords stored as a strong one-way hash)", "Account has a role", and
 * sign-up does not reveal whether an email is registered.
 */
import {
  apiErrorResponseSchema,
  messageResponseSchema,
  PASSWORD_MIN_LENGTH,
} from "@padelloyalty/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import {
  APP_URL,
  PASSWORD,
  buildAuthApp,
  connectTestDatabase,
  resetAuthTables,
  type TestApp,
} from "./support/auth-app.js";

let connection: DatabaseConnection;
let t: TestApp;

beforeAll(async () => {
  connection = await connectTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  await resetAuthTables(connection);
  t = await buildAuthApp(connection);
});
afterEach(async () => {
  await t.app.close();
});

async function userRow(email: string) {
  const [row] = await connection.db.select().from(users).where(eq(users.email, email));
  return row;
}

describe("POST /auth/signup", () => {
  it("creates a pending member account and emails a verification link", async () => {
    const response = await t.post("/auth/signup", { email: "ana@example.com", password: PASSWORD });

    expect(response.statusCode).toBe(202);
    expect(messageResponseSchema.parse(response.json()).message).toMatch(/verify/i);

    const row = await userRow("ana@example.com");
    expect(row).toMatchObject({ role: "member", status: "pending_verification" });
    expect(row?.emailVerifiedAt).toBeNull();

    const email = t.mailer.lastTo("ana@example.com", "verify_email");
    expect(email?.link).toMatch(new RegExp(`^${APP_URL}/verify-email/#token=ple_`));
    expect(email?.text).toContain(email?.link);
  });

  it("stores the password as an argon2id hash, never in plain text", async () => {
    await t.post("/auth/signup", { email: "ana@example.com", password: PASSWORD });

    const row = await userRow("ana@example.com");
    expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(row?.passwordHash).not.toContain(PASSWORD);
  });

  it("normalises the email (trim, lower case)", async () => {
    await t.post("/auth/signup", { email: "  Ana@Example.COM ", password: PASSWORD });

    expect(await userRow("ana@example.com")).toBeDefined();
    expect(t.mailer.lastTo("ana@example.com")).toBeDefined();
  });

  it.each([
    ["too short", "a".repeat(PASSWORD_MIN_LENGTH - 1)],
    ["too long", "a".repeat(129)],
    ["missing", undefined],
  ])("rejects a password that is %s", async (_name, password) => {
    const response = await t.post("/auth/signup", { email: "ana@example.com", password });

    expect(response.statusCode).toBe(400);
    const body = apiErrorResponseSchema.parse(response.json());
    expect(body.error.code).toBe("validation_error");
    expect(body.error.fieldErrors?.password?.length).toBeGreaterThan(0);
    expect(await userRow("ana@example.com")).toBeUndefined();
  });

  it("rejects an invalid email", async () => {
    const response = await t.post("/auth/signup", { email: "not-an-email", password: PASSWORD });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.fieldErrors?.email).toBeDefined();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/signup",
      headers: { "content-type": "application/json" },
      payload: "{nope",
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe("validation_error");
  });

  describe("with an email that is already registered", () => {
    it("answers exactly as for a new email and creates no second account", async () => {
      const first = await t.post("/auth/signup", { email: "ana@example.com", password: PASSWORD });
      await t.post("/auth/verify-email", { token: t.tokenFor("ana@example.com", "verify_email") });
      t.mailer.clear();

      const again = await t.post("/auth/signup", {
        email: "ana@example.com",
        password: "another password",
      });

      expect(again.statusCode).toBe(first.statusCode);
      expect(again.json()).toEqual(first.json());
      const rows = await connection.db.select().from(users);
      expect(rows).toHaveLength(1);
      // The owner is told, and their password is unchanged.
      expect(t.mailer.lastTo("ana@example.com")?.type).toBe("account_exists");
      expect(
        (await t.post("/auth/login", { email: "ana@example.com", password: PASSWORD })).statusCode,
      ).toBe(200);
    });

    it("re-sends the verification link when the account is still unverified", async () => {
      await t.post("/auth/signup", { email: "ana@example.com", password: PASSWORD });
      const firstToken = t.tokenFor("ana@example.com", "verify_email");

      await t.post("/auth/signup", { email: "ana@example.com", password: PASSWORD });
      const secondToken = t.tokenFor("ana@example.com", "verify_email");

      expect(secondToken).not.toBe(firstToken);
      expect(t.mailer.messages.filter((m) => m.type === "verify_email")).toHaveLength(2);
    });

    it("creates one account when the same email signs up twice at once", async () => {
      const results = await Promise.all([
        t.post("/auth/signup", { email: "race@example.com", password: PASSWORD }),
        t.post("/auth/signup", { email: "race@example.com", password: PASSWORD }),
      ]);

      expect(results.map((r) => r.statusCode)).toEqual([202, 202]);
      expect(await connection.db.select().from(users)).toHaveLength(1);
    });
  });
});

describe("roles", () => {
  it("gives new accounts the member role, and /auth/me reports staff roles set later", async () => {
    const { accessToken, user } = await t.signUpVerified("staff@example.com");
    expect((await t.me(accessToken)).json().user.role).toBe("member");

    await connection.db.update(users).set({ role: "receptionist" }).where(eq(users.id, user.id));

    expect((await t.me(accessToken)).json().user.role).toBe("receptionist");
  });

  it("ignores a role sent in the sign-up body", async () => {
    await t.post("/auth/signup", {
      email: "sneaky@example.com",
      password: PASSWORD,
      role: "admin",
    });

    expect((await userRow("sneaky@example.com"))?.role).toBe("member");
  });
});
