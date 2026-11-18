import { ApiStatus } from "@/components/ApiStatus";

export default function MemberHomePage() {
  return (
    <main className="page">
      <header>
        <p className="eyebrow">Soul Padel</p>
        <h1>Welcome</h1>
        <p>Bookings and your Almas loyalty points will appear here.</p>
      </header>
      <ApiStatus />
    </main>
  );
}
