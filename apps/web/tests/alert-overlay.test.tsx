// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from 'react';
import { useLocation, useNavigate } from "react-router-dom";
import { AlertDrawerProvider } from "../src/features/alerts/components/alert-drawer-provider";
import { useAlertDrawer } from "../src/features/alerts/hooks/use-alert-drawer";
import { useTenant } from "../src/app/providers/app-providers";
import { orgA, orgB, alertId } from "./support/alert-fixtures";
import { click, mountAlertUi } from "./support/alert-ui-test-utils";
function Consumer() {
  const drawer = useAlertDrawer(); const tenant = useTenant(); const location = useLocation(); const navigate = useNavigate(); const [showOpener,setShowOpener] = useState(true); const [hiddenOpener,setHiddenOpener] = useState(false);
  return <><output data-location>{location.pathname}{location.search}</output><output data-selection>{JSON.stringify(drawer.selection)}</output><output data-ready>{String(drawer.listReady)}</output><output data-unavailable>{String(drawer.unavailable)}</output>
    <button type="button" data-alert-bell-trigger>Persistent alert bell</button>{showOpener ? <button hidden={hiddenOpener} onClick={(event) => drawer.openAlert({ organizationId: orgA, alertId }, event.currentTarget)}>Open</button> : null}<button onClick={() => setShowOpener(false)}>Remove opener</button><button onClick={() => setHiddenOpener(true)}>Hide opener</button><button onClick={(event) => drawer.openAlert({ organizationId: orgA, alertId }, event.currentTarget.parentElement ?? undefined)}>Open nonfocusable</button><button onClick={drawer.closeAlert}>Close</button>
    <button onClick={() => tenant.selectOrganization(orgB)}>Change tenant</button><button onClick={() => navigate(-1)}>Back</button><button onClick={() => navigate(1)}>Forward</button></>;
}
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => { await mounted?.unmount(); mounted = undefined; vi.unstubAllGlobals(); });
const text = (selector: string) => mounted?.container.querySelector(selector)?.textContent;
const button = (name: string) => [...(mounted?.container.querySelectorAll("button") ?? [])].find((item) => item.textContent === name) ?? null;
describe("global alert selection with real providers and router", () => {
  it.each(['removed opener', 'hidden opener', 'nonfocusable opener', 'direct link'])('restores the persistent bell after closing with %s', async (kind) => {
    mounted = await mountAlertUi(<AlertDrawerProvider><Consumer /></AlertDrawerProvider>, kind === 'direct link' ? `/alerts?alertId=${alertId}&alertOrganizationId=${orgA}` : '/alerts');
    if (kind === 'removed opener' || kind === 'hidden opener') { await click(button('Open')); await click(button(kind === 'removed opener' ? 'Remove opener' : 'Hide opener')); } else if (kind === 'nonfocusable opener') await click(button('Open nonfocusable'));
    await click(button('Close')); await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(document.activeElement).toBe(mounted.container.querySelector('[data-alert-bell-trigger]'));
  });
  it("opens, browser-backs, forwards and closes while preserving list filters and scroll", async () => {
    mounted = await mountAlertUi(<AlertDrawerProvider><Consumer /></AlertDrawerProvider>, "/alerts?tab=history&page=3&custom=keep"); mounted.container.scrollTop = 80;
    await click(button("Open")); expect(text("[data-selection]")).toContain(alertId); expect(text("[data-location]")).toContain("page=3"); expect(mounted.container.scrollTop).toBe(80);
    await click(button("Back")); expect(text("[data-selection]")).toBe("null"); await click(button("Forward")); expect(text("[data-selection]")).toContain(alertId);
    await click(button("Close")); expect(text("[data-location]")).toBe("/alerts?tab=history&page=3&custom=keep");
  });
  it("clears old tenant selection and VM/page state before new tenant list is ready", async () => {
    mounted = await mountAlertUi(<AlertDrawerProvider><Consumer /></AlertDrawerProvider>, `/alerts?page=4&vmId=${alertId}&q=CPU`);
    await click(button("Open")); await click(button("Change tenant"));
    expect(text("[data-selection]")).toBe("null"); expect(text("[data-location]")).not.toContain("vmId="); expect(text("[data-location]")).not.toContain("page=4"); expect(text("[data-ready]")).toBe("true");
  });
  it("accepts an authorized different-org deep link but rejects a nonmember without probing", async () => {
    mounted = await mountAlertUi(<AlertDrawerProvider><Consumer /></AlertDrawerProvider>, `/dashboard?alertId=${alertId}&alertOrganizationId=${orgB}`);
    expect(text("[data-selection]")).toContain(orgB); await mounted.unmount(); mounted = undefined;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mounted = await mountAlertUi(<AlertDrawerProvider><Consumer /></AlertDrawerProvider>, `/alerts?alertId=${alertId}&alertOrganizationId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    expect(text("[data-selection]")).toBe("null"); expect(text("[data-unavailable]")).toBe("true"); expect(fetch).not.toHaveBeenCalled();
  });
});
