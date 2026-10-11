type AgentPlatform = "Linux" | "Windows";
type CopyFeedback = { copiedPlatform?: AgentPlatform; error?: string };

/** One modal/token session. Reset invalidates pending writes as well as timers. */
export function createAgentCopyFeedback() {
  let snapshot: CopyFeedback = {};
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function publish(next: CopyFeedback) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }

  function reset() {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    publish({});
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reset,
    async copy(platform: AgentPlatform, command: string) {
      reset();
      const request = generation;
      try {
        await navigator.clipboard.writeText(command);
        if (request !== generation) return;
        publish({ copiedPlatform: platform });
        timer = setTimeout(reset, 2000);
      } catch {
        if (request !== generation) return;
        publish({ error: "Clipboard access is unavailable. Select the command and copy it manually." });
      }
    },
  };
}
