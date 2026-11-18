import { POINTS_NAME } from "@padelloyalty/shared";
import { ApiStatus } from "@/components/ApiStatus";
import { MemberAccount } from "@/components/auth/MemberAccount";

export default function MemberHomePage() {
  return (
    <main className="page">
      <header>
        <p className="eyebrow">Soul Padel</p>
        <h1>Welcome</h1>
        <p>Bookings and your {POINTS_NAME} will appear here.</p>
      </header>
      <MemberAccount />
      <ApiStatus />
    </main>
  );
}
