import type { Metadata } from "next";
import Link from "next/link";
import { ApiStatus } from "@/components/ApiStatus";

export const metadata: Metadata = {
  title: "Staff back office · Soul Padel",
};

export default function AdminHomePage() {
  return (
    <main className="page">
      <header>
        <p className="eyebrow">Soul Padel staff</p>
        <h1>Back office</h1>
        <p>Check-ins, bookings and member tools for staff will appear here.</p>
      </header>
      <ApiStatus />
      <p>
        <Link href="/">Member app</Link>
      </p>
    </main>
  );
}
