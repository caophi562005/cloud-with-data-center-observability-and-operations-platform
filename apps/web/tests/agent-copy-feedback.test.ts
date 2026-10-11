import { afterEach, describe, expect, it, vi } from "vitest";
import * as copyFeedback from "../src/features/vms/lib/agent-copy-feedback";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("agent copy feedback", () => {
  it("provides a lifecycle-scoped clipboard feedback store", () => {
    expect(copyFeedback.createAgentCopyFeedback).toBeTypeOf("function");
  });

  it("copies only on request and shows success only after the clipboard resolves", async () => {
    vi.useFakeTimers();
    const clipboard = deferred();
    const writes: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: (text: string) => { writes.push(text); return clipboard.promise; } } });
    const store = copyFeedback.createAgentCopyFeedback();
    expect(writes).toEqual([]);
    const pending = store.copy("Linux", "linux-command");
    expect(writes).toEqual(["linux-command"]);
    expect(store.getSnapshot().copiedPlatform).toBeUndefined();
    clipboard.resolve();
    await pending;
    expect(store.getSnapshot().copiedPlatform).toBe("Linux");
    vi.advanceTimersByTime(1999);
    expect(store.getSnapshot().copiedPlatform).toBe("Linux");
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().copiedPlatform).toBeUndefined();
  });

  it("clears success and errors when closing or replacing the token", async () => {
    vi.useFakeTimers();
    let fails = false;
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { if (fails) throw new Error("denied"); } } });
    const store = copyFeedback.createAgentCopyFeedback();
    await store.copy("Windows", "command");
    store.reset();
    expect(store.getSnapshot()).toEqual({});
    fails = true;
    await store.copy("Linux", "command");
    expect(store.getSnapshot().copiedPlatform).toBeUndefined();
    expect(store.getSnapshot().error).toContain("copy it manually");
    store.reset();
    expect(store.getSnapshot()).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)("ignores late clipboard %s after close and reopen", async (outcome) => {
    const clipboard = deferred();
    vi.stubGlobal("navigator", { clipboard: { writeText: () => clipboard.promise } });
    const store = copyFeedback.createAgentCopyFeedback();
    const pending = store.copy("Linux", "old-token-command");
    store.reset();
    clipboard[outcome]();
    await pending;
    expect(store.getSnapshot()).toEqual({});
  });

  it("ignores an older request when a newer platform copy succeeds", async () => {
    vi.useFakeTimers();
    const first = deferred();
    vi.stubGlobal("navigator", { clipboard: { writeText: (command: string) => command === "first" ? first.promise : Promise.resolve() } });
    const store = copyFeedback.createAgentCopyFeedback();
    const pending = store.copy("Linux", "first");
    await store.copy("Windows", "second");
    first.reject();
    await pending;
    expect(store.getSnapshot()).toEqual({ copiedPlatform: "Windows" });
    store.reset();
  });

  it("reports unavailable clipboard access without false success", async () => {
    vi.stubGlobal("navigator", {});
    const store = copyFeedback.createAgentCopyFeedback();
    await store.copy("Linux", "command");
    expect(store.getSnapshot().copiedPlatform).toBeUndefined();
    expect(store.getSnapshot().error).toContain("Clipboard access is unavailable");
  });
});
