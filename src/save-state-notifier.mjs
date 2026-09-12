/** Suppress equivalent UI notifications without touching the save queue. */
export function createSaveStateNotifier(notify) {
  let current = { status: "saved" };
  return next => {
    if (current.status === next.status && current.error === next.error) return;
    current = next;
    notify(next);
  };
}
