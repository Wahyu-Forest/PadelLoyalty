"use client";

import Link from "next/link";
import { Suspense } from "react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { BackOfficeGate } from "@/components/admin/BackOfficeGate";
import { ClubEditor } from "@/components/admin/ClubEditor";

/** `/admin/club/?id=<clubId>`: a query parameter, since the static export has no dynamic routes. */
export default function ClubPage() {
  return (
    <main className="page wide">
      <header>
        <p className="eyebrow">
          <Link href="/admin/clubs/">Clubs and courts</Link>
        </p>
        <h1>Club setup</h1>
        <AdminHeader />
      </header>
      <BackOfficeGate require="admin">
        {() => (
          <Suspense fallback={<p aria-busy="true">Loading club…</p>}>
            <ClubEditor />
          </Suspense>
        )}
      </BackOfficeGate>
    </main>
  );
}
