import type { Metadata } from "next";
import Link from "next/link";
import { VerifyEmail } from "@/components/auth/VerifyEmail";

export const metadata: Metadata = {
  title: "Verify email · Soul Padel",
};

export default function Page() {
  return (
    <main className="page narrow">
      <header>
        <p className="eyebrow">
          <Link href="/">Soul Padel</Link>
        </p>
        <h1>Verify your email</h1>
      </header>
      <VerifyEmail />
    </main>
  );
}
