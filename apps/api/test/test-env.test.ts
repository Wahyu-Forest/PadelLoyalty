import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDotEnv, requireTestDatabaseUrl } from "./support/test-env.js";

const FROM_FILE = "postgres://padel:padel@localhost:5433/from_dotenv";
const FROM_SHELL = "postgres://padel:padel@localhost:5434/from_shell";

let dir: string | undefined;
function envFile(contents: string): string {
  dir = mkdtempSync(join(tmpdir(), "padel-test-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, contents);
  return file;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readDotEnv (loads apps/api/.env for Vitest)", () => {
  it("returns TEST_DATABASE_URL from the file when the shell does not set it", () => {
    const file = envFile(`# comment\nTEST_DATABASE_URL=${FROM_FILE}\nLOG_LEVEL=silent\n`);

    expect(readDotEnv(file, {})).toEqual({ TEST_DATABASE_URL: FROM_FILE, LOG_LEVEL: "silent" });
  });

  it("lets a shell variable override the file", () => {
    const file = envFile(`TEST_DATABASE_URL=${FROM_FILE}\n`);

    expect(readDotEnv(file, { TEST_DATABASE_URL: FROM_SHELL })).toEqual({});
  });

  it("returns nothing when the file does not exist", () => {
    expect(readDotEnv(join(tmpdir(), "padel-no-such-dir", ".env"), {})).toEqual({});
  });
});

describe("requireTestDatabaseUrl", () => {
  it("returns TEST_DATABASE_URL", () => {
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: FROM_FILE })).toBe(FROM_FILE);
  });

  it("does not fall back to a default database when TEST_DATABASE_URL is unset or blank", () => {
    expect(() => requireTestDatabaseUrl({})).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: "  " })).toThrow(
      /TEST_DATABASE_URL is not set/,
    );
  });

  it("refuses to use the development database", () => {
    expect(() =>
      requireTestDatabaseUrl({ TEST_DATABASE_URL: FROM_FILE, DATABASE_URL: FROM_FILE }),
    ).toThrow(/same as DATABASE_URL \(postgres:\/\/padel:\*\*\*@localhost:5433\/from_dotenv\)/);
  });
});
