"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { BackOfficeGate } from "@/components/admin/BackOfficeGate";
import { ClubForm } from "@/components/admin/ClubForm";
import { useClubsApi } from "@/components/admin/useClubsApi";

function NewClub() {
  const api = useClubsApi();
  const router = useRouter();
  return (
    <ClubForm
      submitLabel="Create club"
      submit={(body) => api.createClub(body)}
      onSaved={(club) => router.push(`/admin/club/?id=${club.id}`)}
    />
  );
}

export default function NewClubPage() {
  return (
    <main className="page wide">
      <header>
        <p className="eyebrow">
          <Link href="/admin/clubs/">Clubs and courts</Link>
        </p>
        <h1>New club</h1>
        <AdminHeader />
      </header>
      <BackOfficeGate require="admin">{() => <NewClub />}</BackOfficeGate>
    </main>
  );
}
