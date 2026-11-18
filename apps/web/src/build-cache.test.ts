/**
 * Regression test for PR #69 review, bug 1: Turborepo must hash the
 * (git-ignored) .env files, otherwise changing NEXT_PUBLIC_API_URL in
 * apps/web/.env.local replays a cached build with the old URL.
 *
 * Uses `turbo run --dry=json`, which computes task hashes without running anything.
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const turbo = join(repoRoot, "node_modules", ".bin", "turbo");

// Matches the `.env*` input glob and the `.env.*` gitignore rule, like `.env.local`,
// but has a unique name so it can't clash with a developer's real env files.
const created: string[] = [];
function writeEnvFile(packageDir: string, contents: string) {
  const file = join(repoRoot, packageDir, ".env.turbo-cache-check");
  writeFileSync(file, contents);
  created.push(file);
}

function taskHash(task: string, filter: string, taskId: string): string {
  const output = execFileSync(turbo, ["run", task, "--dry=json", `--filter=${filter}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  });
  const plan = JSON.parse(output) as { tasks: { taskId: string; hash: string }[] };
  const entry = plan.tasks.find((t) => t.taskId === taskId);
  if (!entry) throw new Error(`turbo dry run has no task ${taskId}`);
  return entry.hash;
}

afterEach(() => {
  for (const file of created.splice(0)) rmSync(file, { force: true });
});

describe("Turborepo cache keys include .env files", () => {
  it.each([
    ["build", "@padelloyalty/web", "apps/web"],
    ["test:e2e", "@padelloyalty/web", "apps/web"],
    ["test", "@padelloyalty/api", "apps/api"],
  ])("%s in %s changes hash when an env file changes", (task, filter, dir) => {
    const taskId = `${filter}#${task}`;

    writeEnvFile(dir, "NEXT_PUBLIC_API_URL=http://api-a.example\n");
    const before = taskHash(task, filter, taskId);
    writeEnvFile(dir, "NEXT_PUBLIC_API_URL=http://api-b.example\n");
    const after = taskHash(task, filter, taskId);

    expect(after).not.toBe(before);
  });
});
