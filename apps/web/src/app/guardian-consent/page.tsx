import type { Metadata } from "next";
import Link from "next/link";
import { GuardianConsent } from "@/components/auth/GuardianConsent";

export const metadata: Metadata = {
  title: "Parent or guardian consent · Soul Padel",
};

export default function Page() {
  return (
    <main className="page narrow">
      <header>
        <p className="eyebrow">
          <Link href="/">Soul Padel</Link>
        </p>
        <h1>Parent or guardian consent</h1>
      </header>
      <GuardianConsent />
    </main>
  );
}
