/** A single mounted composer's buffer. Each scope retains its own commit callback. */
export function createComposerDraftBuffer(scopeKey, value, onCommit, options = {}) {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const delayMs = options.delayMs ?? 300;
  let slot = { scopeKey, value, externalValue: value, onCommit, dirty: false, timer: null };

  function flushSlot(target) {
    if (target.timer !== null) cancel(target.timer);
    target.timer = null;
    if (!target.dirty) return;
    target.dirty = false;
    // The library commits synchronously. Remember the submitted value even when
    // React batches the acknowledgement with a following send/clear operation.
    target.externalValue = target.value;
    target.onCommit(target.value);
  }

  return {
    get value() { return slot.value; },
    edit(nextValue) {
      slot.value = nextValue;
      slot.dirty = true;
      if (slot.timer !== null) cancel(slot.timer);
      const owner = slot;
      owner.timer = schedule(() => flushSlot(owner), delayMs);
    },
    receive(nextScope, nextValue, nextCommit) {
      if (nextScope !== slot.scopeKey) {
        flushSlot(slot);
        slot = { scopeKey: nextScope, value: nextValue, externalValue: nextValue, onCommit: nextCommit, dirty: false, timer: null };
      } else {
        slot.onCommit = nextCommit;
        if (nextValue !== slot.externalValue) {
          slot.externalValue = nextValue;
          if (!slot.dirty) slot.value = nextValue;
        }
      }
      return slot.value;
    },
    flush() { flushSlot(slot); },
  };
}
