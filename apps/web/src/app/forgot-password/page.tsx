import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = {
  title: "Forgot password · Soul Padel",
};

export default function Page() {
  return (
    <main className="page narrow">
      <header>
        <p className="eyebrow">
          <Link href="/">Soul Padel</Link>
        </p>
        <h1>Forgot your password?</h1>
      </header>
      <ForgotPasswordForm />
    </main>
  );
}
