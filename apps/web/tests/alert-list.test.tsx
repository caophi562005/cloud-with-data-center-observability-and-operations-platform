// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertsPage } from "../src/features/alerts/pages/alerts-page";
import { AlertDrawerProvider } from "../src/features/alerts/components/alert-drawer-provider";
import { alertFixture, orgA } from "./support/alert-fixtures";
import { click, mountAlertUi } from "./support/alert-ui-test-utils";
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => { await mounted?.unmount(); mounted = undefined; vi.unstubAllGlobals(); });
const buttons = (label: string) => [...(mounted?.container.querySelectorAll("button") ?? [])].find((item) => item.textContent?.includes(label)) ?? null;
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); }
function boundaryFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url), "https://localhost"); const query = path.searchParams;
    if (path.pathname.endsWith("/members")) return new Response(JSON.stringify([]));
    if (path.pathname.endsWith("/vms")) return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 100 }));
    if (path.pathname.endsWith("/alerts")) {
      if (query.get("pageSize") === "1") { const total = query.has("workflowStatus") ? 101 : query.has("severity") ? 4 : 123; return new Response(JSON.stringify({ items: [], total, page: 1, pageSize: 1 })); }
      const isHistory = query.get("signalStatus") === "RESOLVED";
      return new Response(JSON.stringify({ items: [alertFixture({ alertName: isHistory ? "VMDiskUsageHigh" : "VMHighCPU", signalStatus: isHistory ? "RESOLVED" : "FIRING" })], total: 123, page: Number(query.get("page") ?? 1), pageSize: 50 }));
    }
    throw new Error("Unexpected boundary request");
  });
}
describe("real alert list with external HTTP boundary only", () => {
  it("suppresses manual Retry and Refresh throughout a rate-limit cooldown", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'RATE_LIMITED', message: 'Unavailable' }), { status: 429, headers: { 'Retry-After': '60' } })); vi.stubGlobal('fetch', fetch);
    mounted = await mountAlertUi(<AlertDrawerProvider><AlertsPage /></AlertDrawerProvider>); await settle();
    expect(buttons('Retry')?.disabled).toBe(true); expect(buttons('Refresh')?.disabled).toBe(true);
    const before = fetch.mock.calls.length; await click(buttons('Retry')); await click(buttons('Refresh')); await settle(); expect(fetch.mock.calls).toHaveLength(before);
  });
  it("shows global filtered totals, server rows, seven columns and a keyboard action without local counts", async () => {
    const fetch = boundaryFetch(); vi.stubGlobal("fetch", fetch);
    mounted = await mountAlertUi(<AlertDrawerProvider><AlertsPage /></AlertDrawerProvider>); await settle();
    expect(mounted.container.textContent).toContain("123"); expect(mounted.container.textContent).toContain("101"); expect(mounted.container.textContent).toContain("4");
    expect(mounted.container.querySelectorAll("thead th")).toHaveLength(7); expect(buttons("VMHighCPU")).not.toBeNull(); expect(mounted.container.textContent).toContain("edge-example");
    const listCalls = fetch.mock.calls.map(([url]) => new URL(String(url), "https://localhost")).filter((url) => url.pathname.endsWith("/alerts"));
    expect(listCalls.every((url) => url.pathname.includes(orgA))).toBe(true); expect(listCalls.some((url) => url.searchParams.get("workflowStatus") === "OPEN" && url.searchParams.get("pageSize") === "1")).toBe(true);
  });
  it("switches history and sends page requests while counts stay global", async () => {
    const fetch = boundaryFetch(); vi.stubGlobal("fetch", fetch); mounted = await mountAlertUi(<AlertDrawerProvider><AlertsPage /></AlertDrawerProvider>); await settle();
    await click(buttons("History")); await settle(); expect(mounted.container.textContent).toContain("VMDiskUsageHigh");
    await click(mounted.container.querySelector('button[aria-label="Next"]')); await settle();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("page=2"))).toBe(true); expect(mounted.container.textContent).toContain("123");
  });
  it("does not fetch VM inventory until the resource selector is opened", async () => {
    const fetch = boundaryFetch(); vi.stubGlobal("fetch", fetch); mounted = await mountAlertUi(<AlertDrawerProvider><AlertsPage /></AlertDrawerProvider>); await settle();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/vms"))).toBe(false);
    await click(buttons("Filter resource")); await settle();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/vms"))).toBe(true);
  });
  it("shows unavailable errors rather than fabricated rows and allows explicit retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Forbidden", code: "AUTH_FORBIDDEN" }), { status: 403 })));
    mounted = await mountAlertUi(<AlertDrawerProvider><AlertsPage /></AlertDrawerProvider>); await settle();
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toMatch(/permission|access|unavailable/i); expect(buttons("Retry")).not.toBeNull(); expect(mounted.container.textContent).not.toContain("VMHighCPU");
  });
});
