import { createHash, randomBytes } from "node:crypto";
import { hash, verify, type Algorithm } from "@node-rs/argon2";

/**
 * argon2id with the OWASP Password Storage Cheat Sheet baseline
 * (19 MiB memory, 2 iterations, 1 lane).
 */
export const ARGON2_OPTIONS = {
  // Algorithm.Argon2id; a const enum, which verbatimModuleSyntax cannot import.
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash so a login for an unknown email takes about
 * as long as one for a registered email (no timing-based enumeration).
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummyHash, password);
}

/** Prefixes make leaked tokens easy to recognise (e.g. by secret scanners). */
export const TOKEN_PREFIX = {
  access: "pla_",
  refresh: "plr_",
  email: "ple_",
  consent: "plc_",
} as const;

/** 256 bits of randomness, base64url, with a type prefix. */
export function generateToken(kind: keyof typeof TOKEN_PREFIX): string {
  return TOKEN_PREFIX[kind] + randomBytes(32).toString("base64url");
}

/**
 * Tokens are high-entropy random values, so a fast unsalted SHA-256 is enough
 * to make a database leak useless: the hashes cannot be replayed or reversed.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
