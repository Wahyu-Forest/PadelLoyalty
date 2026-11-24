"use client";

import Link from "next/link";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { BackOfficeGate } from "@/components/admin/BackOfficeGate";
import { ClubList } from "@/components/admin/ClubList";

export default function ClubsPage() {
  return (
    <main className="page wide">
      <header>
        <p className="eyebrow">
          <Link href="/admin/">Back office</Link>
        </p>
        <h1>Clubs and courts</h1>
        <AdminHeader />
      </header>
      <BackOfficeGate require="admin">{() => <ClubList />}</BackOfficeGate>
    </main>
  );
}
