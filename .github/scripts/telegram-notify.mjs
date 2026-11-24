// Forwards the team's GitHub activity (Uno, Duo, Quan) to a Telegram chat.
//
// Reads the event payload from GITHUB_EVENT_PATH and never interpolates
// user-controlled text into a shell, so comment bodies can't inject commands.
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (repository secrets).
// Exits quietly when they are missing, so forks and unconfigured repos don't fail.

import { readFileSync } from "node:fs";

// Agent comments, reviews and PRs end with this session-link footer.
const AGENT_MARKER = "claude.ai/code/session";
const AGENTS = ["Uno", "Duo", "Quan"];

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Which team member wrote this: an explicit "**Uno:**" prefix, else the branch name. */
export function whoWrote(body = "", branch = "") {
  const prefix = body.match(/^\s*\**\s*(Uno|Duo|Quan)\b/i);
  if (prefix) return AGENTS.find((a) => a.toLowerCase() === prefix[1].toLowerCase());
  const fromBranch = branch.match(/^(uno|duo|quan)\//i);
  if (fromBranch) return AGENTS.find((a) => a.toLowerCase() === fromBranch[1].toLowerCase());
  return "Claude";
}

/** First meaningful lines of a markdown body, without the footer, as plain text. */
export function summarise(body = "", max = 500) {
  const cut = body.split(/\n-{3,}\s*\n|🤖 Generated with/)[0];
  const text = cut
    .replace(/^\s*\**\s*(Uno|Duo|Quan)\s*:?\**\s*:?/i, "")
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

const isAgent = (body) => typeof body === "string" && body.includes(AGENT_MARKER);
const ICONS = { Uno: "🛠", Duo: "🔧", Quan: "🧪", Claude: "🤖" };

/** Turns a GitHub event into a message, or null when it isn't worth sending. */
export function build(EVENT, payload) {
  if (EVENT === "issue_comment" && payload.action === "created") {
    const c = payload.comment;
    if (!isAgent(c.body)) return null;
    const i = payload.issue;
    return {
      who: whoWrote(c.body),
      title: `${i.pull_request ? "PR" : "Issue"} #${i.number} ${i.title}`,
      text: summarise(c.body),
      url: c.html_url,
    };
  }
  if (EVENT === "pull_request_review" && payload.action === "submitted") {
    const r = payload.review;
    if (!isAgent(r.body)) return null;
    const pr = payload.pull_request;
    return {
      who: whoWrote(r.body),
      title: `Review on PR #${pr.number} ${pr.title}`,
      text: summarise(r.body),
      url: r.html_url,
    };
  }
  if (EVENT === "pull_request") {
    const pr = payload.pull_request;
    const who = whoWrote(pr.body ?? "", pr.head?.ref ?? "");
    if (payload.action === "opened" && isAgent(pr.body)) {
      return {
        who,
        title: `Opened PR #${pr.number} ${pr.title}`,
        text: summarise(pr.body, 300),
        url: pr.html_url,
      };
    }
    if (payload.action === "closed") {
      const verb = pr.merged ? "✅ Merged" : "Closed";
      return { who, title: `${verb} PR #${pr.number} ${pr.title}`, text: "", url: pr.html_url };
    }
    return null;
  }
  if (EVENT === "workflow_run" && payload.action === "completed") {
    const run = payload.workflow_run;
    if (run.conclusion !== "failure") return null;
    return {
      who: whoWrote("", run.head_branch ?? ""),
      title: `❌ ${run.name} failed on ${run.head_branch}`,
      text: run.display_title ?? "",
      url: run.html_url,
    };
  }
  return null;
}

const MAX_ATTEMPTS = 4;
const MAX_WAIT_SECONDS = 90;

/**
 * Seconds to wait before retrying, or null when retrying won't help.
 * 429 uses Telegram's retry_after; 5xx and network-level hiccups back off briefly.
 */
export function retryDelaySeconds(status, out, attempt) {
  if (status === 429) {
    const after = Number(out?.parameters?.retry_after) || 5 * attempt;
    return Math.min(after + 1, MAX_WAIT_SECONDS);
  }
  if (status >= 500) return Math.min(5 * attempt, MAX_WAIT_SECONDS);
  return null;
}

/** Telegram HTML message text. */
export function format(msg) {
  const lines = [
    `${ICONS[msg.who] ?? "🤖"} <b>${escapeHtml(msg.who)}</b> · ${escapeHtml(msg.title)}`,
  ];
  if (msg.text) lines.push("", escapeHtml(msg.text));
  lines.push("", `<a href="${escapeHtml(msg.url)}">Open on GitHub</a>`);
  return lines.join("\n").slice(0, 4000);
}

async function main() {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set; skipping.");
    return;
  }
  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const msg = build(event, payload);
  if (!msg) {
    console.log(`Nothing to send for ${event}/${payload.action}.`);
    return;
  }
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: format(msg),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  // Telegram rate-limits bots (HTTP 429 with parameters.retry_after). Wait and
  // retry a few times rather than dropping the update.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok && out.ok) {
      console.log(attempt === 1 ? "Sent." : `Sent on attempt ${attempt}.`);
      return;
    }
    // Never print the token; Telegram's description is enough to diagnose.
    console.error(`Telegram API error ${res.status}: ${out.description ?? "unknown"}`);
    const wait = retryDelaySeconds(res.status, out, attempt);
    if (wait === null || attempt === MAX_ATTEMPTS) break;
    console.log(`Retrying in ${wait}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS})...`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  process.exit(1);
}

if (process.env.GITHUB_ACTIONS === "true") await main();
