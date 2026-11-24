import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = {
  title: "Reset password · Soul Padel",
};

export default function Page() {
  return (
    <main className="page narrow">
      <header>
        <p className="eyebrow">
          <Link href="/">Soul Padel</Link>
        </p>
        <h1>Choose a new password</h1>
      </header>
      <ResetPasswordForm />
    </main>
  );
}
