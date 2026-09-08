// Coalesce UI changes while keeping at most one bridge write in flight.
// A rejected snapshot remains pending until an explicit retry or a new edit.
export function createLibrarySaver(save, notify, delay = 350) {
  let pending;
  let running;
  let timer;
  let generation = 0;
  let failed = false;
  let lastError;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (running) return running;
    running = Promise.resolve().then(async () => {
      while (pending) {
        const snapshot = pending;
        const version = generation;
        pending = undefined;
        notify({ status: "saving" });
        try {
          await save(snapshot);
          failed = false;
          lastError = undefined;
        } catch (error) {
          if (generation === version) pending = snapshot;
          failed = true;
          lastError = error;
          notify({ status: "error", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
      notify({ status: "saved" });
    }).finally(() => { running = undefined; });
    return running;
  };

  return {
    schedule(snapshot) {
      pending = snapshot;
      generation += 1;
      notify({ status: "saving" });
      if (!timer && !running) timer = setTimeout(() => { void flush().catch(() => undefined); }, delay);
    },
    flush,
    isDirty: () => Boolean(pending || running || failed),
    error: () => lastError,
    cancelTimer() { clearTimeout(timer); timer = undefined; },
  };
}
