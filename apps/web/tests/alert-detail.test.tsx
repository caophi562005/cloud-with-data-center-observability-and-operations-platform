// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { AppLayout } from "../src/app/layouts/app-layout";
import { useAlertDrawer } from "../src/features/alerts/hooks/use-alert-drawer";
import { click } from "./support/alert-ui-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDetailDrawer } from "../src/features/alerts/components/alert-detail-drawer";
import { alertFixture, alertId, eventFixture, orgA } from "./support/alert-fixtures";
import { mountAlertUi } from "./support/alert-ui-test-utils";
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => { await mounted?.unmount(); mounted = undefined; vi.unstubAllGlobals(); });
function setupFetch(emptyHistory = false, eventFailure = false) {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/members")) return new Response(JSON.stringify([]));
    if (String(url).includes("/events")) return eventFailure ? new Response(JSON.stringify({ message: "Unavailable" }), { status: 403 }) : new Response(JSON.stringify({ items: emptyHistory ? [] : [eventFixture()], total: emptyHistory ? 0 : 1, page: 1, pageSize: 50 }));
    return new Response(JSON.stringify(alertFixture({ annotations: { summary: "<script>unsafe()</script>", description: "Actual summary" } })));
  }));
}
function media(mobile: boolean) { vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }); }
function Opener() { const drawer = useAlertDrawer(); return <button data-open-alert onClick={(event) => drawer.openAlert({ organizationId: orgA, alertId }, event.currentTarget)}>Open contextual alert</button>; }
describe("actual PxlKit detail drawer with boundary HTTP", () => {
  it('restores the actual persistent header bell when a deep-link drawer had no opener', async()=>{
    setupFetch(); media(false); mounted=await mountAlertUi(<Routes><Route element={<AppLayout />}><Route path='/alerts' element={<Opener />} /></Route></Routes>, `/alerts?alertId=${alertId}&alertOrganizationId=${orgA}`); await settle();
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close alert detail"]')); await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(mounted.container.querySelector('[data-alert-bell-trigger]'));
  });
  it("uses one global drawer, inerts only shell and restores live opener and scroll", async () => {
    setupFetch(); media(false); mounted = await mountAlertUi(<Routes><Route element={<AppLayout />}><Route path="/alerts" element={<Opener />} /></Route></Routes>);
    const opener = mounted.container.querySelector('[data-open-alert]') as HTMLButtonElement; const scroll = mounted.container.querySelector('main')?.parentElement as HTMLElement; scroll.scrollTop = 120; opener.focus(); await click(opener); await settle();
    const shell = mounted.container.querySelector('[data-sidebar-collapsed]'); const dialog = document.querySelector('[role="dialog"]');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1); expect(shell?.hasAttribute('inert')).toBe(true); expect(dialog?.closest('[inert]')).toBeNull(); expect(dialog?.contains(document.activeElement)).toBe(true);
    const close = [...(dialog?.querySelectorAll('button') ?? [])].find((item) => item.getAttribute('aria-label') === 'Close alert detail') as HTMLButtonElement; close.focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))); expect(dialog?.contains(document.activeElement)).toBe(true); expect(document.activeElement).not.toBe(close);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(shell?.hasAttribute('inert')).toBe(false); expect(document.activeElement).toBe(opener); expect(scroll.scrollTop).toBe(120);
  });

  it("renders named desktop480 drawer, exact dates, safe text and persisted activity", async () => {
    setupFetch(); media(false); mounted = await mountAlertUi(<AlertDetailDrawer selection={{ organizationId: orgA, alertId }} onClose={vi.fn()} />); await settle();
    const panel = document.querySelector('[role="dialog"]'); expect(panel).not.toBeNull(); expect(panel?.className).toContain("w-[480px]");
    expect(panel?.getAttribute("aria-modal")).toBe("true"); expect(panel?.textContent).toContain("VMHighCPU"); expect(panel?.textContent).toContain("edge-example");
    expect(panel?.querySelector("script")).toBeNull(); expect(panel?.textContent).toContain("<script>unsafe()</script>"); expect(panel?.textContent).toContain("System");
    expect(panel?.querySelector('time[datetime="2026-10-10T00:00:00.123456789Z"]')).not.toBeNull(); expect(panel?.querySelector('a[href="/vms/22222222-2222-4222-8222-222222222222"]')).not.toBeNull();
  });
  it("uses mobile full width and closes on Escape using PxlKit", async () => {
    setupFetch(); media(true); const close = vi.fn(); mounted = await mountAlertUi(<AlertDetailDrawer selection={{ organizationId: orgA, alertId }} onClose={close} />); await settle();
    expect(document.querySelector('[role="dialog"]')?.className).toContain("w-screen");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); expect(close).toHaveBeenCalledOnce();
  });
  it("does not fabricate signal history for a legacy row", async () => {
    setupFetch(true); media(false); mounted = await mountAlertUi(<AlertDetailDrawer selection={{ organizationId: orgA, alertId }} onClose={vi.fn()} />); await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/no recorded activity/i);
  });
  it("keeps detail usable when events fail independently", async () => {
    setupFetch(false, true); media(false); mounted = await mountAlertUi(<AlertDetailDrawer selection={{ organizationId: orgA, alertId }} onClose={vi.fn()} />); await settle();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("VMHighCPU"); expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toMatch(/activity.*unavailable/i);
  });
});
