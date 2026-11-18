import { POINTS_NAME } from "@padelloyalty/shared";
import { ApiStatus } from "@/components/ApiStatus";

export default function MemberHomePage() {
  return (
    <main className="page">
      <header>
        <p className="eyebrow">Soul Padel</p>
        <h1>Welcome</h1>
        <p>Bookings and your {POINTS_NAME} will appear here.</p>
      </header>
      <ApiStatus />
    </main>
  );
}
