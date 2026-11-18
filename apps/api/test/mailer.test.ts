import { describe, expect, it } from "vitest";
import { CapturingMailer, ConsoleMailer, tokenFromLink } from "../src/email/mailer.js";

const message = {
  to: "ana@example.com",
  type: "verify_email" as const,
  subject: "Verify",
  text: "Open http://app.test/verify-email/#token=ple_abc",
  link: "http://app.test/verify-email/#token=ple_abc",
};

describe("ConsoleMailer", () => {
  it("logs the recipient, subject and link instead of sending", async () => {
    const lines: string[] = [];
    await new ConsoleMailer((line) => lines.push(line)).send(message);

    expect(lines.join("\n")).toContain("ana@example.com");
    expect(lines.join("\n")).toContain("Verify");
    expect(lines.join("\n")).toContain(message.link);
  });
});

describe("CapturingMailer", () => {
  it("keeps messages and finds the latest per address and type", async () => {
    const mailer = new CapturingMailer();
    await mailer.send(message);
    await mailer.send({ ...message, type: "password_reset", link: "http://app.test/r#token=2" });

    expect(mailer.messages).toHaveLength(2);
    expect(mailer.lastTo("ANA@example.com")?.type).toBe("password_reset");
    expect(mailer.lastTo("ana@example.com", "verify_email")?.link).toBe(message.link);
    mailer.clear();
    expect(mailer.messages).toEqual([]);
  });
});

describe("tokenFromLink", () => {
  it("reads the token from the fragment", () => {
    expect(tokenFromLink(message.link)).toBe("ple_abc");
    expect(() => tokenFromLink("http://app.test/verify-email/")).toThrow();
  });
});
