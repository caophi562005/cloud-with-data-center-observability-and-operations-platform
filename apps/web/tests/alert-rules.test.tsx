// @vitest-environment jsdom
import { act } from "react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { AlertRulesPage } from "../src/features/alerts/pages/alert-rules-page";
import { ProtectedRoute } from "../src/app/router/protected-route";
import { navigationSections } from "../src/app/navigation/navigation.config";
import { click, mountAlertUi } from "./support/alert-ui-test-utils";
import { queryClient } from "../src/lib/query/query-client";
import { orgA } from "./support/alert-fixtures";
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});
function Location() {
  return <output aria-label="URL">{useLocation().pathname}</output>;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}
const payload = {
  scope: "SHARED_VM_RULES",
  managedBy: "Terraform / AWS AMP",
  items: [
    {
      name: "VMHighCPU",
      severity: "WARNING",
      promql: "cpu_usage > 80",
      forSeconds: 300,
      intervalSeconds: 60,
      namespace: "opsgrid-dev-vm-alerts",
      group: "opsgrid-vm-health",
      health: "ok",
      state: "inactive",
      activeAlerts: 0,
      lastEvaluation: "2026-10-11T01:00:00Z",
      labels: { severity: "warning" },
      annotations: {
        summary: "CPU usage is high",
        description: "CPU high for five minutes",
      },
    },
  ],
};
const button = (label: string) =>
  [...(mounted?.container.querySelectorAll("button") ?? [])].find((item) =>
    item.textContent?.includes(label),
  );
describe("actual protected Rules UI with only external HTTP boundary replaced", () => {
  it("renders returned configuration and current-tenant state, not invented rule/editor rows", async () => {
    const fetch = vi.fn(async () => Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    mounted = await mountAlertUi(<AlertRulesPage />, "/alert-rules");
    await settle();
    expect(mounted.container.textContent).toContain("VMHighCPU");
    expect(mounted.container.textContent).toContain("Inactive");
    expect(mounted.container.textContent).toContain("Terraform");
    expect(mounted.container.textContent).toContain("AWS AMP");
    expect(mounted.container.textContent).not.toMatch(
      /VMHighMemory|Create rule|Edit rule/,
    );
    expect(fetch.mock.calls.length).toBeGreaterThan(0);
    expect(String((fetch.mock.calls as unknown[][])[0]?.[0])).toContain(
      `/organizations/${orgA}/alert-rules`,
    );
    await click(button("VMHighCPU") ?? null);
    expect(mounted.container.textContent).toContain("cpu_usage > 80");
    expect(mounted.container.textContent).toContain("CPU usage is high");
    expect(mounted.container.textContent).toContain("opsgrid-dev-vm-alerts");
  });
  it("shows genuine empty when API returns no shared rules", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...payload, items: [] })),
    );
    mounted = await mountAlertUi(<AlertRulesPage />);
    await settle();
    expect(mounted.container.textContent).toContain("No shared VM rules");
    expect(mounted.container.textContent).not.toContain("VMHighCPU");
  });
  it("shows permission failure with no fake rule and no stale table", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "AUTH_FORBIDDEN", message: "Unavailable" },
          { status: 403 },
        ),
      ),
    );
    mounted = await mountAlertUi(<AlertRulesPage />);
    await settle();
    expect(
      mounted.container.querySelector('[role="alert"]')?.textContent,
    ).toMatch(/permission/i);
    expect(mounted.container.textContent).not.toContain("VMHighCPU");
  });
  it("blocks Refresh and Retry throughout rate-limit cooldown", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { code: "RATE_LIMITED", message: "Unavailable" },
        { status: 429, headers: { "Retry-After": "60" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    mounted = await mountAlertUi(<AlertRulesPage />);
    await settle();
    expect(button("Refresh")?.disabled).toBe(true);
    expect(button("Retry")?.disabled).toBe(true);
    const before = fetch.mock.calls.length;
    await click(button("Retry") ?? null);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(before);
  });
  it("provides working Alerts navigation and preserves routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...payload, items: [] })),
    );
    mounted = await mountAlertUi(
      <>
        <AlertRulesPage />
        <Location />
      </>,
      "/alert-rules",
    );
    await click(mounted.container.querySelector('a[href="/alerts"]'));
    expect(
      mounted.container.querySelector('[aria-label="URL"]')?.textContent,
    ).toBe("/alerts");
    expect(
      navigationSections
        .flatMap((section) => section.items)
        .some((item) => item.href === "/alert-rules"),
    ).toBe(true);
    const router = readFileSync("src/app/router/router.tsx", "utf8");
    for (const path of [
      "/alert-rules",
      "/alerts",
      "/dashboard",
      "/vms",
      "/vms/:vmId",
    ])
      expect(router).toContain(`path: "${path}"`);
  });
  it("retains existing session protection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: "UNAUTHENTICATED", message: "Session unavailable" },
          { status: 401 },
        ),
      ),
    );
    mounted = await mountAlertUi(
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/alert-rules" element={<AlertRulesPage />} />
        </Route>
        <Route path="/login" element={<p>Login required</p>} />
      </Routes>,
      "/alert-rules",
    );
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["me"] });
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(mounted.container.textContent).toContain("Login required");
    expect(mounted.container.textContent).not.toContain("VMHighCPU");
  });
});
