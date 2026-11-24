/**
 * Email sending abstraction. The provider is chosen later (#1 decision); until
 * then development logs emails and tests capture them.
 */

export type EmailType = "verify_email" | "password_reset" | "account_exists";

export interface EmailMessage {
  to: string;
  type: EmailType;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** The action link in the email, if any (full URL). */
  link?: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

type LogFn = (line: string) => void;

/** Development mailer: prints each email, link included, instead of sending it. */
export class ConsoleMailer implements Mailer {
  constructor(private readonly log: LogFn = (line) => console.log(line)) {}

  async send(message: EmailMessage): Promise<void> {
    this.log(
      [
        "──── email (not sent: development mailer) ────",
        `To:      ${message.to}`,
        `Subject: ${message.subject}`,
        "",
        message.text,
        "─────────────────────────────────────────────",
      ].join("\n"),
    );
  }
}

/** Test mailer: keeps every email in memory. */
export class CapturingMailer implements Mailer {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }

  /** The most recent email to `to` (optionally of one type). */
  lastTo(to: string, type?: EmailType): EmailMessage | undefined {
    const address = to.trim().toLowerCase();
    return this.messages.findLast(
      (message) => message.to === address && (type === undefined || message.type === type),
    );
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/** Extracts the token from a link of the form `…#token=<token>`. */
export function tokenFromLink(link: string): string {
  const hash = new URL(link).hash.replace(/^#/, "");
  const token = new URLSearchParams(hash).get("token");
  if (!token) throw new Error(`No #token= in link ${link}`);
  return token;
}
