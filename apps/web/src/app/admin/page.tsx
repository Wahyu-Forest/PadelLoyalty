import type { Metadata } from "next";
import Link from "next/link";
import { ApiStatus } from "@/components/ApiStatus";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { AdminHome } from "@/components/admin/AdminHome";

export const metadata: Metadata = {
  title: "Staff back office · Soul Padel",
};

export default function AdminHomePage() {
  return (
    <main className="page wide">
      <header>
        <p className="eyebrow">Soul Padel staff</p>
        <h1>Back office</h1>
        <AdminHeader />
      </header>
      <AdminHome />
      <ApiStatus />
      <p>
        <Link href="/">Member app</Link>
      </p>
    </main>
  );
}
