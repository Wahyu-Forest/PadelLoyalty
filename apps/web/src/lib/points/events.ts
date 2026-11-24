/**
 * "The member's points changed" signal (#6). Features that change points call
 * `notifyPointsChanged()` after a successful response, e.g. earn on check-in
 * (#7) and redeem (#15); every visible balance then refetches from the API.
 * Other tabs of the app hear it too (BroadcastChannel, where available).
 */

const EVENT = "padelloyalty:points-changed";
const CHANNEL = "padelloyalty-points";

type Listener = () => void;

/** This tab's id, so a tab ignores its own broadcasts (it already got the window event). */
const TAB_ID = Math.random().toString(36).slice(2);

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
}

/** Tell every balance on screen (this tab and others) to refetch. */
export function notifyPointsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(EVENT));
  const broadcast = channel();
  if (broadcast) {
    broadcast.postMessage({ type: "changed", from: TAB_ID });
    broadcast.close();
  }
}

/** Calls `listener` whenever points change, here or in another tab. Returns an unsubscribe. */
export function onPointsChanged(listener: Listener): () => void {
  if (typeof window === "undefined") return () => {};
  const onEvent = () => listener();
  window.addEventListener(EVENT, onEvent);
  const broadcast = channel();
  if (broadcast) {
    broadcast.onmessage = (message: MessageEvent<{ from?: string }>) => {
      if (message.data?.from !== TAB_ID) listener();
    };
  }
  return () => {
    window.removeEventListener(EVENT, onEvent);
    broadcast?.close();
  };
}
