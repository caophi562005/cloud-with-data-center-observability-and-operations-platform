import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/lib/query/query-keys";
import type { Vm } from "../src/features/vms/vm.types";
import { linuxCapabilities, windowsCapabilities, unknownCapabilities, nativeTelemetry, unknownTelemetry } from "./fixtures/vms";

const tenant = vi.hoisted(() => ({ id: "org-one" as string | null }));
vi.mock("../src/app/providers/app-providers", () => ({ useTenant: () => ({ currentOrganization: tenant.id ? { id: tenant.id } : null }) }));
const vmId = "a8910fdd-77c8-4050-b7f8-6c0123456789";
const vm: Vm = { ...unknownTelemetry, agent: null, id: vmId, hostname: "real-only-host", osType: "Linux", osVersion: "Linux", ipAddress: "—", status: "DISCONNECTED", tags: { site: "sea" }, tagIds: { site: "tag-one" }, agentStatus: "ACTIVE", createdAt: "2026-10-01T00:00:00Z", lastSeenAt: null, metrics: null, metricsState: "empty" };
afterEach(() => { tenant.id = "org-one"; vi.restoreAllMocks(); });
async function renderDetail(client: QueryClient, id = vmId) {
  const { VmDetailPage } = await import("../src/features/vms/pages/vm-detail-page");
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: [`/vms/${id}`] }, createElement(Routes, null, createElement(Route, { path: "/vms/:vmId", element: createElement(VmDetailPage) })))));
}

describe("real detail rendering", () => {
  it("shows no-organization and invalid-link states instead of disabled-query endless loading", async () => {
    const client = new QueryClient();
    tenant.id = null; expect(await renderDetail(client)).toContain("No organization selected");
    tenant.id = "org-one"; expect(await renderDetail(client, "old-demo-id")).toContain("Invalid virtual machine link"); client.clear();
  });
  it("never displays a previous tenant's cached VM", async () => {
    const client = new QueryClient(); client.setQueryData(queryKeys.vm("org-one", vmId), vm);
    tenant.id = "org-two"; const markup = await renderDetail(client);
    expect(markup).not.toContain("real-only-host"); expect(markup).toContain("Loading virtual machine"); client.clear();
  });
  it.each([[403, "Access denied"], [404, "Virtual machine not found"]] as const)("renders scoped detail %s instead of cached inventory", async (statusCode, title) => {
    const { ApiError } = await import("../src/lib/api/api-error");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    client.setQueryData(queryKeys.vm("org-one", vmId), vm);
    await client.fetchQuery({ queryKey: queryKeys.vm("org-one", vmId), staleTime: 0, queryFn: () => Promise.reject(new ApiError(statusCode, "VM_ACCESS", "Unable to access this VM.")) }).catch(() => undefined);
    const markup = await renderDetail(client);
    expect(markup).toContain(title); expect(markup).not.toContain("real-only-host"); client.clear();
  });
  it.each(["METRICS_DISABLED", "METRICS_UNAVAILABLE"])("distinguishes %s from empty metrics and retains inventory", async (code) => {
    const { ApiError } = await import("../src/lib/api/api-error");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    client.setQueryData(queryKeys.vm("org-one", vmId), vm);
    for (const queryKey of [queryKeys.vmCurrentMetrics("org-one", vmId), queryKeys.vmMetricsRange("org-one", vmId, "1h")]) {
      await client.fetchQuery({ queryKey, queryFn: () => Promise.reject(new ApiError(503, code, "Metrics unavailable.")) }).catch(() => undefined);
    }
    const markup = await renderDetail(client);
    expect(markup).toContain("real-only-host"); expect(markup).toContain(code === "METRICS_DISABLED" ? "Metrics integration is disabled" : "Current metrics are unavailable");
    expect(markup).not.toContain("No fresh telemetry samples"); expect(markup).toContain("Retry telemetry charts"); client.clear();
  });
  it("keeps absent enrollment and current telemetry neutral despite disconnected inventory", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, agentStatus: null });
    try {
      const markup = await renderDetail(client);
      expect(markup).toContain("Unknown host state");
      expect(markup).not.toContain(">Disconnected<");
      expect(markup).toMatch(/>Credential<\/dt><dd[^>]*>Not reported<\/dd>/);
      expect(markup).toContain("Reinstall locally");
      expect(markup).toContain("Recover agent");
      expect(markup).toContain('id="vm-inventory-heading"');
    } finally { client.clear(); }
  });

  it("renders actual metric zeros, nullable dashes, normalized chart samples and four tabs", async () => {
    const client = new QueryClient(); client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, ...nativeTelemetry, lastSeenAt: "2026-10-03T00:00:00Z" });
    client.setQueryData(queryKeys.vmCurrentMetrics("org-one", vmId), { ...nativeTelemetry, hostState: "WARNING", sampledAt: "2026-10-04T00:00:00Z", lastSeenAt: null, status: "WARNING", metricsState: "available", metrics: { cpu: 0, memory: null, disk: 84, networkRx: 1.5, networkTx: null, load: 0, uptimeHours: 49 } });
    client.setQueryData(queryKeys.vmMetricsRange("org-one", vmId, "1h"), { ...nativeTelemetry, metricsState: "available", from: "2026-10-04T00:00:00Z", to: "2026-10-04T01:00:00Z", step: 60, series: { cpu: [{ timestamp: "2026-10-04T00:00:00Z", value: 0 }, { timestamp: "2026-10-04T00:01:00Z", value: null }], memory: [], disk: [], networkRx: [], networkTx: [], load: [] } });
    const markup = await renderDetail(client);
    expect(markup).toContain("real-only-host"); expect(markup).toContain("0.0%"); expect(markup).toContain("—"); expect(markup).toContain("View CPU utilization samples");
    expect(markup).toContain(">Warning<");
    expect(markup).toMatch(/>Last metric delivery \([^<]+\)<\/dt><dd[^>]*>Not reported<\/dd>/);
    expect(markup).toContain(`Timestamp (${Intl.DateTimeFormat().resolvedOptions().timeZone})`); expect(markup).toContain("Missing"); expect(markup).toContain("7d"); expect(markup).not.toContain("hard-coded snapshot"); client.clear();
  });
});

// Consumer tests catch unsupported-as-missing/zero and capability/provider precedence regressions.
const currentFixture = { ...nativeTelemetry, sampledAt: "2026-10-04T00:00:00Z", lastSeenAt: null, status: "HEALTHY", metricsState: "available", metrics: { cpu: 0, memory: 2, disk: 3, networkRx: 0, networkTx: 5, load: 9, uptimeHours: 49 } };
const rangeFixture = {
  ...nativeTelemetry, metricsState: "available",
  from: "2026-10-04T00:00:00Z", to: "2026-10-04T01:00:00Z", step: 60,
  series: Object.fromEntries(["cpu", "memory", "disk", "networkRx", "networkTx", "load"].map((key) => [key, [{ timestamp: "2026-10-04T00:00:00Z", value: 0 }, { timestamp: "2026-10-04T00:01:00Z", value: null }, { timestamp: "2026-10-04T00:02:00Z", value: 2 }]])),
};
function metricCard(markup: string, label: string) {
  return markup.match(new RegExp(`<section[^>]*aria-label="${label} metric"[^>]*>[\\s\\S]*?<\\/section>`))?.[0] ?? "";
}
function seedMetrics(client: QueryClient, capabilities?: typeof windowsCapabilities | typeof unknownCapabilities | typeof linuxCapabilities) {
  client.setQueryData(queryKeys.vm("org-one", vmId), vm);
  client.setQueryData(queryKeys.vmCurrentMetrics("org-one", vmId), { ...currentFixture, ...(capabilities ? { metricsCapabilities: capabilities } : {}) });
  client.setQueryData(queryKeys.vmMetricsRange("org-one", vmId, "1h"), { ...rangeFixture, ...(capabilities ? { metricsCapabilities: capabilities } : {}) });
}

describe("capability detail presentation", () => {
  it("windows_load_is_unsupported_not_missing", async () => {
    const client = new QueryClient(); seedMetrics(client, windowsCapabilities);
    try {
      const markup = await renderDetail(client);
      expect(metricCard(markup, "Load")).toContain("N/A");
      expect(metricCard(markup, "Load")).toContain("Unsupported on Windows");
      expect(markup).not.toContain('aria-label="System load chart"');
      expect(markup).not.toContain("View System load samples");
      expect(markup).not.toContain('aria-label="System load telemetry samples"');
      expect(markup.match(/<svg[^>]*role="img"/g)).toHaveLength(5);
      for (const [label, value] of [["CPU", "0.0%"], ["Memory", "2.0%"], ["Disk", "3.0%"], ["Network RX / TX", "0.0 / 5.0"], ["Uptime", "2d 1h"]]) expect(metricCard(markup, label)).toContain(value);
      expect(markup).toContain("Missing");
      expect(markup.match(/<circle/g)).toHaveLength(10); // Null splits each supported chart into two zero/2 samples.
    } finally { client.clear(); }
  });
  it.each(["ACTIVE", "REVOKED"] as const)("unknown reason leaves %s agent lifecycle unchanged", async (agentStatus) => {
    const client = new QueryClient(); seedMetrics(client, unknownCapabilities);
    client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, agentStatus });
    client.setQueryData(queryKeys.vmCurrentMetrics("org-one", vmId), { ...currentFixture, ...unknownTelemetry, hostState: "unsupported", telemetryDelivery: "unsupported", status: "DISCONNECTED", sampledAt: null, lastSeenAt: null, metricsState: "unsupported", metricsCapabilities: unknownCapabilities });
    try {
      const markup = await renderDetail(client);
      expect(markup).toContain("Unsupported platform");
      expect(markup).not.toContain("No fresh telemetry");
      expect(markup).not.toContain('role="img"');
      expect(markup).not.toContain("telemetry samples</summary>");
      expect(metricCard(markup, "CPU")).toContain("N/A");
      expect(markup).toMatch(new RegExp(`>Credential<\\/dt><dd[^>]*>${agentStatus}<\\/dd>`));
      expect(markup).toContain("Reinstall locally");
      expect(markup).toContain("Recover agent");
      expect(markup).toContain("Unsupported host state");
      expect(markup).not.toContain(">Disconnected<");
    } finally { client.clear(); }
  });
  it.each([undefined, linuxCapabilities])("legacy and Linux retain load and all six chart/sample tables", async (capabilities) => {
    const client = new QueryClient(); seedMetrics(client, capabilities);
    // Windows OS alone must not infer capabilities.
    client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, osType: "Windows" });
    try {
      const markup = await renderDetail(client);
      expect(metricCard(markup, "Load")).toContain("9.00");
      expect(metricCard(markup, "Load")).not.toContain("Unsupported");
      expect(markup).not.toMatch(/<p[^>]*role="status"[^>]*>Unsupported platform<\/p>/);
      expect(markup.match(/<svg[^>]*role="img"/g)).toHaveLength(6);
      expect(markup).toContain("View System load samples");
    } finally { client.clear(); }
  });
  it("supported missing current values remain dashes, not unsupported", async () => {
    const client = new QueryClient(); seedMetrics(client, windowsCapabilities);
    client.setQueryData(queryKeys.vmCurrentMetrics("org-one", vmId), { ...currentFixture, metricsCapabilities: windowsCapabilities, metrics: { ...currentFixture.metrics, memory: null } });
    try {
      const markup = await renderDetail(client);
      expect(metricCard(markup, "Memory")).toContain("—");
      expect(metricCard(markup, "Memory")).not.toContain("Unsupported");
    } finally { client.clear(); }
  });
  it("uses enriched detail metadata when legacy current/range omit it", async () => {
    const client = new QueryClient(); seedMetrics(client);
    client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, metricsCapabilities: windowsCapabilities });
    try { expect(metricCard(await renderDetail(client), "Load")).toContain("Unsupported on Windows"); } finally { client.clear(); }
  });
  it.each([[503, "METRICS_DISABLED"], [503, "METRICS_UNAVAILABLE"], [500, "INTERNAL_ERROR"], [403, "FORBIDDEN"], [404, "NOT_FOUND"]] as const)("provider/error %s %s wins over cached unknown capabilities", async (statusCode, code) => {
    const { ApiError } = await import("../src/lib/api/api-error");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    seedMetrics(client, unknownCapabilities);
    client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, metricsCapabilities: unknownCapabilities });
    for (const queryKey of [queryKeys.vmCurrentMetrics("org-one", vmId), queryKeys.vmMetricsRange("org-one", vmId, "1h")]) {
      await client.fetchQuery({ queryKey, staleTime: 0, queryFn: () => Promise.reject(new ApiError(statusCode, code, "Metrics unavailable.")) }).catch(() => undefined);
    }
    try {
      const markup = await renderDetail(client);
      expect(markup).not.toMatch(/<p[^>]*role="status"[^>]*>Unsupported platform<\/p>/);
      expect(markup).not.toContain("N/A");
      expect(markup).toContain("Retry current metrics"); expect(markup).toContain("Retry telemetry charts");
      expect(markup).toContain(statusCode === 403 ? "Access denied to VM metrics" : statusCode === 404 ? "Virtual machine not found" : code === "METRICS_DISABLED" ? "Metrics integration is disabled" : "Current metrics are unavailable");
    } finally { client.clear(); }
  });
  it("loading takes precedence over enriched unsupported detail metadata", async () => {
    const client = new QueryClient(); client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, metricsCapabilities: unknownCapabilities });
    try {
      const markup = await renderDetail(client);
      expect(markup).toContain("Loading current metrics"); expect(markup).toContain("Loading telemetry charts");
      expect(markup).not.toMatch(/<p[^>]*role="status"[^>]*>Unsupported platform<\/p>/);
    } finally { client.clear(); }
  });
});

describe("browser-local detail timestamps", () => {
  it("localizes identity, sample tables and chart titles consistently", async () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new NativeDateTimeFormat(locales ?? "en-US", { timeZone: "Asia/Ho_Chi_Minh", ...options });
    });
    const client = new QueryClient();
    const stamp = "2026-10-04T07:42:00Z";
    client.setQueryData(queryKeys.vm("org-one", vmId), { ...vm, createdAt: stamp, lastSeenAt: stamp });
    client.setQueryData(queryKeys.vmCurrentMetrics("org-one", vmId), {
      ...nativeTelemetry, sampledAt: stamp, lastSeenAt: stamp, status: "HEALTHY", metricsState: "available",
      metrics: { cpu: 1, memory: 2, disk: 3, networkRx: 0, networkTx: 0, load: 0, uptimeHours: 1 },
    });
    client.setQueryData(queryKeys.vmMetricsRange("org-one", vmId, "1h"), {
      ...nativeTelemetry, metricsState: "available", from: stamp, to: "2026-10-04T08:42:00Z", step: 60,
      series: { cpu: [{ timestamp: stamp, value: 1 }], memory: [], disk: [], networkRx: [], networkTx: [], load: [] },
    });
    try {
      const markup = await renderDetail(client);
      expect(markup).toMatch(/>Created \(Asia\/(?:Ho_Chi_Minh|Saigon)\)<\/dt><dd[^>]*><time [dD]ate[Tt]ime="2026-10-04T07:42:00Z">Oct 4, 2:42 PM<\/time>/);
      expect(markup).toContain("Sampled Oct 4, 2:42 PM");
      expect(markup).toMatch(/Timestamp \(Asia\/(?:Ho_Chi_Minh|Saigon)\)/);
      expect(markup).toContain("Oct 4, 2:42:00 PM");
      expect(markup).toContain("Oct 4, 2:42:00 PM to Oct 4, 3:42:00 PM");
      expect(markup).not.toContain("· UTC");
    } finally { client.clear(); }
  });
});

describe("timestamp plots and tag drafts", () => {
  it("preserves null gaps and scales irregular samples to actual timestamps, including zero", async () => {
    const module = await import("../src/features/vms/lib/metric-series");
    const segments = module.metricSegments([{ timestamp: "2026-10-04T00:00:00Z", value: 0 }, { timestamp: "2026-10-04T00:01:00Z", value: 10 }, { timestamp: "2026-10-04T00:02:00Z", value: null }, { timestamp: "2026-10-04T00:03:00Z", value: 20 }], "2026-10-04T00:00:00Z", "2026-10-04T00:04:00Z", 60);
    expect(segments).toEqual([[{ x: 0, value: 0 }, { x: 0.25, value: 10 }], [{ x: 0.75, value: 20 }]]);
  });
  it("does not connect missing step intervals or nonfinite samples", async () => {
    const module = await import("../src/features/vms/lib/metric-series");
    expect(module.metricSegments([{ timestamp: "2026-10-04T00:00:00Z", value: 0 }, { timestamp: "2026-10-04T00:03:00Z", value: 20 }, { timestamp: "2026-10-04T00:04:00Z", value: Infinity }], "2026-10-04T00:00:00Z", "2026-10-04T01:00:00Z", 60)).toHaveLength(2);
  });
  it("keeps the draft and stable editing ID after failed save, clearing only on successful save", async () => {
    const { tagDraftReducer, EMPTY_TAG_DRAFT } = await import("../src/features/vms/lib/tag-draft");
    const draft = tagDraftReducer(EMPTY_TAG_DRAFT, { type: "edit", key: "site", value: "sea", tagId: "tag-one" });
    const pending = tagDraftReducer(draft, { type: "pending" });
    const failed = tagDraftReducer(pending, { type: "failed", error: "This tag already exists." });
    expect(failed).toMatchObject({ key: "site", value: "sea", tagId: "tag-one", pending: false, error: "This tag already exists." });
    expect(tagDraftReducer(failed, { type: "saved" })).toEqual(EMPTY_TAG_DRAFT);
  });
});
