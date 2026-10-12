import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import * as api from "../src/features/vms/api/vms.api";
import * as hooks from "../src/features/vms/hooks/use-vms";
import { queryKeys } from "../src/lib/query/query-keys";

import { windowsCapabilities, unknownCapabilities } from "./fixtures/vms";

const metrics = { cpu: 0, memory: null, disk: 84, networkRx: 1.25, networkTx: null, load: 0, uptimeHours: 49 };
const record = { id: "a8910fdd-77c8-4050-b7f8-6c0123456789", organizationId: "org/one", hostname: "real-node", ipAddress: null, os: "Linux", status: "WARNING", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", tags: [{ id: "tag/one", key: "site", value: "sea" }], agent: { status: "ACTIVE", enrolledAt: "2026-10-01T00:00:00Z", lastSeenAt: null }, metrics, lastSeenAt: "2026-10-04T00:00:00Z", metricsState: "available" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("real VM adapters", () => {
  // Detect adapters dropping metadata, deriving it from OS, or fabricating legacy support.
  it.each(["available", "empty", "disabled", "unavailable"])("propagates enriched %s capabilities through inventory and detail", async (metricsState) => {
    const body = { ...record, os: "Linux", metricsState, metricsCapabilities: windowsCapabilities };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ items: [body], page: 1, pageSize: 100, total: 1 })).mockResolvedValueOnce(json(body)));
    const [listed] = await api.getVms("org/one");
    const detail = await api.getVm("org/one", record.id);
    for (const result of [listed, detail]) {
      expect(result).toMatchObject({ metricsCapabilities: { platform: "windows", supported: ["cpu", "memory", "disk", "networkRx", "networkTx", "uptimeHours"] }, metrics, metricsState });
    }
  });
  it("retains unknown metadata and legacy absence without inferring from OS or null values", async () => {
    const unknown = { ...record, metrics: null, metricsCapabilities: unknownCapabilities };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(unknown)).mockResolvedValueOnce(json({ ...record, os: "Windows", metrics: null })));
    expect(await api.getVm("org", record.id)).toMatchObject({ metricsCapabilities: { platform: "unknown", supported: [] }, agentStatus: "ACTIVE" });
    expect(await api.getVm("org", record.id)).not.toHaveProperty("metricsCapabilities");
  });
  it("preserves current and range metadata and legacy absence through the consumer boundary", async () => {
    const current = { sampledAt: null, lastSeenAt: null, status: "DISCONNECTED", metricsState: "empty", metrics };
    const range = { from: "2026-10-04T00:00:00Z", to: "2026-10-04T01:00:00Z", step: 60, series: { cpu: [], memory: [], disk: [], networkRx: [], networkTx: [], load: [] } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ ...current, metricsCapabilities: windowsCapabilities })).mockResolvedValueOnce(json({ ...range, metricsCapabilities: unknownCapabilities })).mockResolvedValueOnce(json(current)).mockResolvedValueOnce(json(range)));
    expect(await api.getVmCurrentMetrics("org", record.id)).toMatchObject({ metricsCapabilities: { platform: "windows", supported: ["cpu", "memory", "disk", "networkRx", "networkTx", "uptimeHours"] }, metrics });
    expect(await api.getVmMetricsRange("org", record.id, "1h")).toMatchObject({ metricsCapabilities: { platform: "unknown", supported: [] }, series: range.series });
    expect(await api.getVmCurrentMetrics("org", record.id)).not.toHaveProperty("metricsCapabilities");
    expect(await api.getVmMetricsRange("org", record.id, "1h")).not.toHaveProperty("metricsCapabilities");
  });
  it("keeps enriched metrics, authoritative last-seen and stable tag IDs in inventory", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ items: [record], page: 1, pageSize: 100, total: 1 })));
    const [vm] = await api.getVms("org/one");
    expect(vm.metrics).toEqual(metrics);
    expect(vm).toMatchObject({ lastSeenAt: "2026-10-04T00:00:00Z", metricsState: "available", tagIds: { site: "tag/one" } });
  });
  it("loads current telemetry with credentials, encoded tenant/VM and cancellation", async () => {
    expect(api).toHaveProperty("getVmCurrentMetrics");
    const signal = new AbortController().signal;
    const body = { sampledAt: null, lastSeenAt: record.lastSeenAt, status: "DISCONNECTED", metrics, metricsState: "empty" };
    const fetcher = vi.fn().mockResolvedValue(json(body)); vi.stubGlobal("fetch", fetcher);
    await expect(api.getVmCurrentMetrics("org/one", "vm/one", signal)).resolves.toEqual(body);
    expect(fetcher).toHaveBeenCalledWith("/api/v1/organizations/org%2Fone/vms/vm%2Fone/metrics/current", expect.objectContaining({ signal, credentials: "include" }));
  });
  it.each(["1h", "6h", "24h", "7d"] as const)("loads %s normalized series without synthesizing missing or zero values", async (range) => {
    expect(api).toHaveProperty("getVmMetricsRange");
    const body = { from: "2026-10-04T00:00:00Z", to: "2026-10-04T01:00:00Z", step: 60, series: { cpu: [{ timestamp: "2026-10-04T00:00:00Z", value: 0 }, { timestamp: "2026-10-04T00:01:00Z", value: null }], memory: [], disk: [], networkRx: [], networkTx: [], load: [] } };
    const fetcher = vi.fn().mockResolvedValue(json(body)); vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    await expect(api.getVmMetricsRange("org", "vm", range, signal)).resolves.toEqual(body);
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/organizations/org/vms/vm/metrics/range?range=${range}`, expect.objectContaining({ signal, credentials: "include" }));
  });
  it("uses PATCH and DELETE on stable encoded tag IDs", async () => {
    expect(api).toHaveProperty("updateVmTag"); expect(api).toHaveProperty("deleteVmTag");
    const fetcher = vi.fn().mockResolvedValueOnce(json({ id: "tag/one", key: "owner", value: "sre" })).mockResolvedValueOnce(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetcher);
    await api.updateVmTag("org", "vm", "tag/one", { key: "owner", value: "sre" }); await api.deleteVmTag("org", "vm", "tag/one");
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/v1/organizations/org/vms/vm/tags/tag%2Fone", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ key: "owner", value: "sre" }), credentials: "include" }));
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/v1/organizations/org/vms/vm/tags/tag%2Fone", expect.objectContaining({ method: "DELETE", credentials: "include" }));
  });
  it("propagates safe metrics outage codes instead of empty success", async () => {
    expect(api).toHaveProperty("getVmCurrentMetrics");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "METRICS_DISABLED", message: "Metrics are disabled.", statusCode: 503 }, 503)));
    await expect(api.getVmCurrentMetrics("org", "vm")).rejects.toMatchObject({ code: "METRICS_DISABLED", statusCode: 503 });
  });
});

describe("tenant-safe VM query and mutation lifecycle", () => {
  it("separates current from all ranges and tenant keys", () => {
    expect(queryKeys).toHaveProperty("vmCurrentMetrics"); expect(queryKeys).toHaveProperty("vmMetricsRange");
    expect(queryKeys.vmCurrentMetrics("one", "vm")).not.toEqual(queryKeys.vmCurrentMetrics("two", "vm"));
    expect(queryKeys.vmMetricsRange("one", "vm", "1h")).not.toEqual(queryKeys.vmMetricsRange("one", "vm", "6h"));
  });
  it("queries inventory/current on a 30s cadence, does not query invalid IDs, and forwards signals", async () => {
    expect(hooks).toHaveProperty("vmsQueryOptions"); expect(hooks).toHaveProperty("vmCurrentMetricsQueryOptions"); expect(hooks).toHaveProperty("vmMetricsRangeQueryOptions");
    expect(hooks.vmsQueryOptions("org").refetchInterval).toBe(30_000);
    expect(hooks.vmCurrentMetricsQueryOptions("org", record.id).refetchInterval).toBe(30_000);
    expect(hooks.vmCurrentMetricsQueryOptions(null, record.id).enabled).toBe(false);
    expect(hooks.vmMetricsRangeQueryOptions("org", "not-a-uuid", "1h").enabled).toBe(false);
    const fetcher = vi.fn().mockResolvedValue(json({ sampledAt: null, lastSeenAt: null, status: "DISCONNECTED", metrics, metricsState: "empty" })); vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery(hooks.vmCurrentMetricsQueryOptions("org", record.id));
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal); client.clear();
  });
  it.each([["1h", 60_000], ["6h", 60_000], ["24h", 300_000], ["7d", 1_800_000]] as const)("uses %s range resolution for polling and staleness", (range, cadence) => {
    const options = hooks.vmMetricsRangeQueryOptions("org", record.id, range);
    expect(options.refetchInterval).toBe(cadence); expect(options.staleTime).toBe(cadence);
  });
  it("successful tag operations invalidate exact scoped inventory and detail, never another tenant", async () => {
    expect(hooks).toHaveProperty("vmTagMutationOptions");
    const client = new QueryClient();
    client.setQueryData(queryKeys.vms("one"), []); client.setQueryData(queryKeys.vm("one", record.id), record); client.setQueryData(queryKeys.vms("two"), []);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ id: "tag-one", key: "site", value: "sea" })));
    const mutation = new MutationObserver(client, hooks.vmTagMutationOptions(client, "one", record.id));
    await mutation.mutate({ action: "add", input: { key: "site", value: "sea" } });
    expect(client.getQueryState(queryKeys.vms("one"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.vm("one", record.id))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.vms("two"))?.isInvalidated).toBe(false); client.clear();
  });
  it("failed tag mutation rejects and leaves authoritative cached data unchanged", async () => {
    expect(hooks).toHaveProperty("vmTagMutationOptions");
    const client = new QueryClient(); client.setQueryData(queryKeys.vm("one", record.id), record);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "CONFLICT", message: "A tag already exists.", statusCode: 409 }, 409)));
    const mutation = new MutationObserver(client, hooks.vmTagMutationOptions(client, "one", record.id));
    await expect(mutation.mutate({ action: "update", tagId: "tag/one", input: { key: "owner", value: "sre" } })).rejects.toMatchObject({ statusCode: 409 });
    expect(client.getQueryData(queryKeys.vm("one", record.id))).toEqual(record); expect(client.getQueryState(queryKeys.vm("one", record.id))?.isInvalidated).toBe(false); client.clear();
  });
});
