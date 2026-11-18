import type { Metadata } from "next";
import Link from "next/link";
import { LogInForm } from "@/components/auth/LogInForm";

export const metadata: Metadata = {
  title: "Log in · Soul Padel",
};

export default function Page() {
  return (
    <main className="page narrow">
      <header>
        <p className="eyebrow">
          <Link href="/">Soul Padel</Link>
        </p>
        <h1>Log in</h1>
      </header>
      <LogInForm />
    </main>
  );
}
