/**
 * QA (issue #1), AC1 and AC7: sign-up with email and password, password rules,
 * hashing, normalisation, duplicates, default role.
 */
import { createHash } from "node:crypto";
import {
  messageResponseSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  APP_URL,
  expectApiError,
  getMe,
  type Harness,
  logIn,
  makeHarness,
  openTestDatabase,
  ADULT_DOB,
  PASSWORD,
  post,
  signUp,
  uniqueEmail,
} from "./support/auth-harness.js";

let connection: DatabaseConnection;
let h: Harness;

beforeAll(async () => {
  connection = await openTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  h = await makeHarness(connection);
});
afterEach(async () => {
  await h.app.close();
});

/** Every text-like value in every table of the public schema, as one string per cell. */
async function allDatabaseText(): Promise<string[]> {
  const columns = await connection.db.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public' and data_type in ('text', 'character varying', 'jsonb', 'json', 'bytea')
  `);
  const values: string[] = [];
  for (const { table_name, column_name } of columns.rows) {
    const rows = await connection.db.execute<{ v: string | null }>(
      sql.raw(`select "${column_name}"::text as v from "${table_name}"`),
    );
    for (const row of rows.rows) if (row.v) values.push(row.v);
  }
  return values;
}

describe("POST /auth/signup: happy path", () => {
  it("returns 202 with a message and emails a verification link", async () => {
    const email = uniqueEmail();
    const response = await signUp(h, email);

    expect(messageResponseSchema.safeParse(response.json()).success).toBe(true);
    const message = h.mailer.lastTo(email, "verify_email");
    expect(message).toBeTruthy();
    expect(message!.to).toBe(email);
    expect(message!.link).toMatch(new RegExp(`^${APP_URL}/verify-email/#token=.+`));
  });

  it("does not log the user in (no tokens in the response)", async () => {
    const response = await signUp(h, uniqueEmail());
    expect(response.body).not.toMatch(/accessToken|refreshToken/);
  });

  it("creates a member account pending verification", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    const session = await logIn(h, email);

    expect(session.user).toMatchObject({
      email,
      role: "member",
      status: "pending_verification",
      emailVerified: false,
    });
  });

  it("ignores a role sent in the body (no privilege escalation)", async () => {
    const email = uniqueEmail();
    const response = await post(h.app, "/auth/signup", {
      email,
      password: PASSWORD,
      dateOfBirth: ADULT_DOB,
      role: "admin",
    });
    expect([202, 400]).toContain(response.statusCode);
    if (response.statusCode !== 202) return;

    const session = await logIn(h, email);
    expect(session.user.role).toBe("member");
    const me = await getMe(h.app, session.accessToken);
    expect(me.json().user.role).toBe("member");
  });

  it("ignores status / emailVerified sent in the body", async () => {
    const email = uniqueEmail();
    const response = await post(h.app, "/auth/signup", {
      email,
      password: PASSWORD,
      dateOfBirth: ADULT_DOB,
      status: "active",
      emailVerified: true,
    });
    expect([202, 400]).toContain(response.statusCode);
    if (response.statusCode !== 202) return;
    const session = await logIn(h, email);
    expect(session.user.status).toBe("pending_verification");
    expect(session.user.emailVerified).toBe(false);
  });
});

describe("POST /auth/signup: email normalisation and duplicates", () => {
  it("trims and lower-cases the email", async () => {
    const email = uniqueEmail();
    await signUp(h, `  ${email.toUpperCase()}  `);

    expect(h.mailer.lastTo(email, "verify_email")).toBeTruthy();
    const session = await logIn(h, email);
    expect(session.user.email).toBe(email);
    // Any casing logs in to the same account.
    const again = await logIn(h, ` ${email.toUpperCase()}`);
    expect(again.user.id).toBe(session.user.id);
  });

  it.each([
    ["the same address", (e: string) => e],
    ["upper case", (e: string) => e.toUpperCase()],
    ["mixed case", (e: string) => e[0]!.toUpperCase() + e.slice(1)],
    ["surrounding whitespace", (e: string) => `\t ${e} \n`],
  ])("a second sign-up with %s does not create a second account", async (_name, variant) => {
    const email = uniqueEmail();
    const first = await signUp(h, email, PASSWORD);
    const second = await signUp(h, variant(email), "a different password 123");

    // Same response either way (no enumeration).
    expect(second.json()).toEqual(first.json());
    // The original password still works; the second one does not.
    const session = await logIn(h, email, PASSWORD);
    expect(session.user.email).toBe(email);
    expectApiError(
      await post(h.app, "/auth/login", { email, password: "a different password 123" }),
      401,
      "invalid_credentials",
    );
  });

  it("re-sending sign-up for an unverified account emails a fresh verification link", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    h.mailer.clear();
    await signUp(h, email, "another password 1234");

    const types = h.mailer.messages.filter((m) => m.to === email).map((m) => m.type);
    expect(types).toEqual(["verify_email"]);
  });

  it("sign-up for an already verified account emails 'account exists' and no verify link", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    const token = h.mailer.lastTo(email, "verify_email")!.link!.split("#token=")[1]!;
    expect((await post(h.app, "/auth/verify-email", { token })).statusCode).toBe(200);
    h.mailer.clear();

    await signUp(h, email, "another password 1234");
    const types = h.mailer.messages.filter((m) => m.to === email).map((m) => m.type);
    expect(types).toEqual(["account_exists"]);
  });

  it("concurrent sign-ups with the same email create exactly one account", async () => {
    const email = uniqueEmail();
    const passwords = Array.from({ length: 8 }, (_, i) => `concurrent password ${i}`);
    const responses = await Promise.all(
      passwords.map((password, i) =>
        post(h.app, "/auth/signup", {
          email: i % 2 ? email.toUpperCase() : email,
          password,
          dateOfBirth: ADULT_DOB,
        }),
      ),
    );

    for (const r of responses) expect(r.statusCode, r.body).toBe(202);
    const logins = await Promise.all(
      passwords.map((password) => post(h.app, "/auth/login", { email, password })),
    );
    const ok = logins.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
  });
});

describe("POST /auth/signup: password rules", () => {
  const repeat = (n: number) => "p".repeat(n);

  it(`rejects a password of ${PASSWORD_MIN_LENGTH - 1} characters`, async () => {
    const error = expectApiError(
      await post(h.app, "/auth/signup", {
        email: uniqueEmail(),
        password: repeat(PASSWORD_MIN_LENGTH - 1),
        dateOfBirth: ADULT_DOB,
      }),
      400,
      "validation_error",
    );
    expect(error.error.fieldErrors?.password?.length).toBeGreaterThan(0);
  });

  it(`accepts exactly ${PASSWORD_MIN_LENGTH} and exactly ${PASSWORD_MAX_LENGTH} characters`, async () => {
    for (const length of [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]) {
      const email = uniqueEmail();
      await signUp(h, email, repeat(length));
      await logIn(h, email, repeat(length));
    }
  });

  it(`rejects ${PASSWORD_MAX_LENGTH + 1} characters`, async () => {
    expectApiError(
      await post(h.app, "/auth/signup", {
        email: uniqueEmail(),
        password: repeat(PASSWORD_MAX_LENGTH + 1),
        dateOfBirth: ADULT_DOB,
      }),
      400,
      "validation_error",
    );
  });

  it("rejects a 1 MB password quickly with 400, not 500", async () => {
    const started = Date.now();
    const response = await post(h.app, "/auth/signup", {
      email: uniqueEmail(),
      password: "x".repeat(1_000_000),
      dateOfBirth: ADULT_DOB,
    });
    expect([400, 413]).toContain(response.statusCode);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects missing, empty and non-string passwords", async () => {
    for (const password of [undefined, "", null, 1234567890123, ["a long password"]]) {
      expectApiError(
        await post(h.app, "/auth/signup", {
          email: uniqueEmail(),
          password,
          dateOfBirth: ADULT_DOB,
        }),
        400,
        "validation_error",
      );
    }
  });

  it("does not trim passwords: surrounding spaces are part of the password", async () => {
    const email = uniqueEmail();
    const password = "  spaced password  ";
    await signUp(h, email, password);
    await logIn(h, email, password);
    expectApiError(
      await post(h.app, "/auth/login", { email, password: password.trim() }),
      401,
      "invalid_credentials",
    );
  });

  it("counts unicode passwords and logs in with them", async () => {
    const email = uniqueEmail();
    const password = "contraseña-ñandú-🎾🎾";
    await signUp(h, email, password);
    await logIn(h, email, password);
  });
});

describe("POST /auth/signup: invalid input", () => {
  it.each([
    ["missing @", "not-an-email"],
    ["empty", ""],
    ["whitespace only", "   "],
    ["space inside", "ana maria@example.com"],
    ["no domain", "ana@"],
    ["script tag", "<script>alert(1)</script>@example.com"],
    [
      "too long (255 chars)",
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(59)}.com`,
    ],
  ])("rejects an email that is %s with 400 validation_error", async (_name, email) => {
    const error = expectApiError(
      await post(h.app, "/auth/signup", { email, password: PASSWORD, dateOfBirth: ADULT_DOB }),
      400,
      "validation_error",
    );
    expect(error.error.fieldErrors?.email?.length).toBeGreaterThan(0);
  });

  it("answers unicode / IDN emails without a server error", async () => {
    for (const email of ["josé@example.com", "ana@exämple.com", "用户@例子.广告"]) {
      const response = await post(h.app, "/auth/signup", {
        email,
        password: PASSWORD,
        dateOfBirth: ADULT_DOB,
      });
      expect([202, 400], `${email}: ${response.body}`).toContain(response.statusCode);
    }
  });

  it("stores SQL-looking input inertly", async () => {
    const email = `o'brien+${Date.now()}@example.com`;
    const password = "'; drop table users; --";
    await signUp(h, email, password);
    const session = await logIn(h, email, password);
    expect(session.user.email).toBe(email);
  });

  it("returns a contract-shaped 400 for a malformed JSON body", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/auth/signup",
      headers: { "content-type": "application/json" },
      payload: '{"email": "a@example.com", "password": ',
    });
    expectApiError(response, 400, "validation_error");
  });

  it("returns a contract-shaped 400 for an empty body and for a non-object body", async () => {
    for (const payload of ["{}", "[]", '"text"', "null"]) {
      const response = await h.app.inject({
        method: "POST",
        url: "/auth/signup",
        headers: { "content-type": "application/json" },
        payload,
      });
      expectApiError(response, 400, "validation_error");
    }
  });
});

describe("password storage", () => {
  it("never stores the plaintext password or an unsalted fast hash of it", async () => {
    const email = uniqueEmail();
    const password = `plaintext-canary-${Date.now()}`;
    await signUp(h, email, password);

    const digests = ["md5", "sha1", "sha256", "sha512"].flatMap((algo) => [
      createHash(algo).update(password).digest("hex"),
      createHash(algo).update(password).digest("base64"),
    ]);
    const cells = await allDatabaseText();
    for (const cell of cells) {
      expect(cell).not.toContain(password);
      for (const digest of digests) expect(cell).not.toContain(digest);
    }
  });

  it("never echoes the password in responses or emails", async () => {
    const email = uniqueEmail();
    const password = `echo-canary-${Date.now()}`;
    const signup = await signUp(h, email, password);
    const login = await post(h.app, "/auth/login", { email, password });
    const me = await getMe(h.app, login.json().accessToken);

    for (const body of [signup.body, login.body, me.body]) {
      expect(body).not.toContain(password);
      expect(body.toLowerCase()).not.toMatch(/password_?hash|"hash"/);
    }
    for (const message of h.mailer.messages) {
      expect(JSON.stringify(message)).not.toContain(password);
    }
  });
});
