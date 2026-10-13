import { describe, expect, it } from "vitest";
import { INTEGRATION_RANGES, integrationDetailPath, integrationEntityPrefix, integrationRouteSearch, parseIntegrationRoute, resolveIntegrationSelection, vmIntegrationsPath } from "./integration-route";
import { featuredIntegrationDefinitions, integrationMetricValue, integrationReadError, integrationSampleTime } from "./integration-metric-format";
import { metricSegments } from "./metric-series";
import { queryKeys } from "../../../lib/query/query-keys";
import type { IntegrationMetricsCurrent, IntegrationMetricDefinition } from "../integration-metrics.types";

const definition = (key: string): IntegrationMetricDefinition => ({ key, label: key, group: "native", unit: "count", semanticType: "gauge", description: "Native", chart: true });
const current = (kind: IntegrationMetricsCurrent["kind"], keys: string[], entities: string[] = []): IntegrationMetricsCurrent => ({
  kind, instanceId: "instance", queriedAt: "2026-10-13T00:00:00Z", enabled: true, dataState: "no-data", lastSampleAt: null,
  definitions: keys.map(definition), readings: [], entities: entities.map((key) => ({ key, label: key })), entitiesTruncated: false,
});

describe("integration route state and public selection", () => {
  it("defaults invalid tab/range and empty selectors safely", () => {
    expect(parseIntegrationRoute(new URLSearchParams("tab=secret&range=7d&metric=&entity="))).toEqual({ tab: "overview", range: "1h", metric: null, entity: null });
  });
  it("round trips all approved ranges and tabs without unrelated input", () => {
    for (const range of INTEGRATION_RANGES) for (const tab of ["overview", "metrics", "configuration"] as const) {
      const state = { tab, range, metric: "redis_keyspace_keys", entity: "database:db1" };
      expect(parseIntegrationRoute(integrationRouteSearch(state))).toEqual(state);
    }
    expect(integrationRouteSearch(parseIntegrationRoute(new URLSearchParams("tab=metrics&password=do-not-retain"))).toString()).toBe("tab=metrics&range=1h");
  });
  it("rejects endpoint/query syntax and oversized selector input", () => {
    for (const value of ["redis_clients{secret}", "https://private.example", "a".repeat(97)]) expect(parseIntegrationRoute(new URLSearchParams({ metric: value })).metric).toBeNull();
    for (const value of ["https://private.example", "database:db1&token=x", `db:${"x".repeat(129)}`, "container:short:name"]) expect(parseIntegrationRoute(new URLSearchParams({ entity: value })).entity).toBeNull();
  });
  it("returns actual VM integrations tab and encoded nested paths", () => {
    expect(vmIntegrationsPath("vm")).toBe("/vms/vm?tab=integrations");
    expect(integrationDetailPath("a/b", "i?x")).toBe("/vms/a%2Fb/integrations/i%3Fx");
  });
  it("does not put a Redis database on global keys including hit/miss counters", () => {
    const snapshot = current("redis", ["redis_clients", "redis_keyspace_hits", "redis_keyspace_misses", "redis_cache_hit_percent"], ["database:db0"]);
    for (const metric of snapshot.definitions) {
      expect(integrationEntityPrefix("redis", metric.key)).toBeNull();
      expect(resolveIntegrationSelection(snapshot, metric, "database:db0")).toMatchObject({ entityKey: null, entities: [], canChart: true, requiresEntity: false });
    }
  });
  it("uses only exact Redis keyspace entity metrics and known server entities", () => {
    const snapshot = current("redis", ["redis_keyspace_keys", "redis_keyspace_expires", "redis_keyspace_avg_ttl"], ["database:db0", "database:db1"]);
    for (const metric of snapshot.definitions) {
      expect(resolveIntegrationSelection(snapshot, metric, "database:db1").entityKey).toBe("database:db1");
      expect(resolveIntegrationSelection(snapshot, metric, "database:db999").entityKey).toBe("database:db0");
    }
    expect(resolveIntegrationSelection(current("redis", ["redis_keyspace_keys"]), definition("redis_keyspace_keys"), null)).toMatchObject({ canChart: false, requiresEntity: true });
  });
  it("uses only the reported PostgreSQL configured database", () => {
    const snapshot = current("postgresql", ["postgresql_numbackends"], ["db:app"]);
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[0], "db:other").entityKey).toBe("db:app");
    expect(resolveIntegrationSelection(current("postgresql", ["postgresql_numbackends"]), definition("postgresql_numbackends"), "db:guessed").canChart).toBe(false);
  });
  it("makes disabled PostgreSQL retained history selectable from its exact null reading entity", () => {
    const snapshot = current("postgresql", ["postgresql_numbackends"]);
    snapshot.enabled = false; snapshot.dataState = "disabled";
    snapshot.readings = [{ key: "postgresql_numbackends", entityKey: "db:configured", value: null, lastSampleAt: null, state: "no-data", reason: "Integration is disabled" }];
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[0], "db:guessed")).toEqual({
      entityKey: "db:configured", entities: [{ key: "db:configured", label: "configured" }], canChart: true, requiresEntity: true,
    });
    expect(snapshot.entities).toEqual([]);
    expect(snapshot.lastSampleAt).toBeNull();
    expect(snapshot.readings[0]).toMatchObject({ value: null, lastSampleAt: null, state: "no-data" });
    snapshot.dataState = "unsupported";
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[0], null).canChart).toBe(false);
  });
  it("does not recover PostgreSQL entities from another metric or an unknown database request", () => {
    const snapshot = current("postgresql", ["postgresql_numbackends"]);
    snapshot.enabled = false; snapshot.dataState = "disabled";
    snapshot.readings = [{ key: "postgresql_xact_commit", entityKey: "db:configured", value: null, lastSampleAt: null, state: "no-data", reason: null }];
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[0], "db:guessed")).toMatchObject({ entityKey: null, entities: [], canChart: false });
  });
  it("does not fabricate disabled Redis or Docker entities when the reported list is empty", () => {
    for (const [kind, key, entityKey] of [["redis", "redis_keyspace_keys", "database:db0"], ["docker", "docker_container_cpu_usage_percent", "container:012345abcdef:app"]] as const) {
      const snapshot = current(kind, [key]); snapshot.enabled = false; snapshot.dataState = "disabled";
      snapshot.readings = [{ key, entityKey: null, value: null, lastSampleAt: null, state: "no-data", reason: "Integration is disabled" }];
      expect(resolveIntegrationSelection(snapshot, snapshot.definitions[0], entityKey)).toMatchObject({ entityKey: null, entities: [], canChart: false, requiresEntity: true });
    }
  });
  it("separates daemon-wide Docker metrics and known lifecycle/container source", () => {
    const first = "container:012345abcdef:app"; const second = "container:abcdef012345:app";
    const snapshot = current("docker", ["docker_n_containers_running", "docker_container_cpu_usage_percent"], [first, second]);
    expect(parseIntegrationRoute(new URLSearchParams({ entity: second })).entity).toBe(second);
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[0], second)).toMatchObject({ entityKey: null, entities: [], canChart: true, requiresEntity: false });
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[1], second).entityKey).toBe(second);
    expect(resolveIntegrationSelection(snapshot, snapshot.definitions[1], "container:aaaaaaaaaaaa:unknown").entityKey).toBe(first);
  });
  it("caps featured choices at four actual definitions and reads Windows IDs", () => {
    const windows = current("docker", ["docker_n_containers_running", "docker_container_cpu_usage_percent", "docker_container_mem_commit_bytes", "docker_container_mem_private_working_set", "docker_container_net_rx_bytes_per_second"]);
    expect(featuredIntegrationDefinitions(windows).map((metric) => metric.key)).toEqual(["docker_n_containers_running", "docker_container_cpu_usage_percent", "docker_container_mem_commit_bytes", "docker_container_net_rx_bytes_per_second"]);
    expect(featuredIntegrationDefinitions(current("nginx", ["nginx_active", "unknown_metric"])).map((metric) => metric.key)).toEqual(["nginx_active"]);
  });
  it("scopes history keys to org VM instance range metric and entity", () => {
    const base = queryKeys.integrationMetricsHistory("org", "vm", "instance", "1h", "metric", null);
    expect(base).toEqual(["integration-metrics", "org", "vm", "instance", "history", "1h", "metric", null]);
    expect(base).not.toEqual(queryKeys.integrationMetricsHistory("other", "vm", "instance", "1h", "metric", null));
    expect(base).not.toEqual(queryKeys.integrationMetricsHistory("org", "other", "instance", "1h", "metric", null));
    expect(base).not.toEqual(queryKeys.integrationMetricsHistory("org", "vm", "other", "1h", "metric", null));
    expect(base).not.toEqual(queryKeys.integrationMetricsHistory("org", "vm", "instance", "6h", "metric", null));
    expect(base).not.toEqual(queryKeys.integrationMetricsHistory("org", "vm", "instance", "1h", "other", null));
    expect(base).not.toEqual(queryKeys.integrationMetricsHistory("org", "vm", "instance", "1h", "metric", "database:db0"));
    expect(queryKeys.integrationMetricsCurrent("org", "vm", "instance")).toEqual(["integration-metrics", "org", "vm", "instance", "current"]);
  });
  it("keeps zero and high CPU values, null/nonfinite unknown and source time absent", () => {
    expect(integrationMetricValue(0)).toBe("0"); expect(integrationMetricValue(250)).toBe("250");
    for (const value of [null, undefined, NaN, Infinity]) expect(integrationMetricValue(value)).toBe("—");
    expect(integrationSampleTime(null)).toBe("Not reported"); expect(integrationSampleTime("invalid")).toBe("Not reported");
    expect(integrationReadError(503, "Current metrics")).toContain("503");
    expect(integrationReadError(403, "Current metrics")).toContain("Access denied");
    expect(integrationReadError(404, "Current metrics")).toContain("not found");
  });
});

describe("shared metricSegments integration-history edges", () => {
  const from = "2026-10-13T00:00:00Z"; const to = "2026-10-13T00:05:00Z";
  const point = (seconds: number, value: number | null) => ({ timestamp: new Date(Date.parse(from) + seconds * 1000).toISOString(), value });
  it("preserves zero and CPU over 100 without inventing samples", () => {
    expect(metricSegments([point(0, 0), point(30, 240)], from, to, 30).map((segment) => segment.map((item) => item.value))).toEqual([[0, 240]]);
  });
  it("breaks at null, NaN, invalid time and long source gaps", () => {
    expect(metricSegments([point(0, 1), point(30, null), point(60, 2), point(90, NaN), point(120, 3), { timestamp: "bad", value: 99 }, point(180, 4), point(270, 5)], from, to, 30).map((segment) => segment.map((item) => item.value))).toEqual([[1], [2], [3], [4], [5]]);
  });
  it("does not bridge outside-window or nonmonotonic inputs", () => {
    expect(metricSegments([point(-30, 99), point(0, 1), point(30, 2), point(30, 3), point(20, 4), point(400, 99), point(270, 5)], from, to, 30).map((segment) => segment.map((item) => item.value))).toEqual([[1, 2], [3], [4], [5]]);
    expect(metricSegments([point(0, 1)], "bad", to, 30)).toEqual([]);
  });
});
