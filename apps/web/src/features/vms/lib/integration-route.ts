import type { IntegrationMetricsCurrent, IntegrationMetricsRange, IntegrationMetricDefinition } from "../integration-metrics.types";
import type { IntegrationKind } from "../monitoring.types";

export const INTEGRATION_RANGES: IntegrationMetricsRange[] = ["15m", "1h", "6h", "24h"];
export type IntegrationTab = "overview" | "metrics" | "configuration";
export type IntegrationRoute = { tab: IntegrationTab; range: IntegrationMetricsRange; metric: string | null; entity: string | null };
const metricPattern = /^[a-z][a-z0-9_]{0,95}$/;
const entityPattern = /^(?:db:[A-Za-z0-9_.-]{1,128}|database:db[0-9]{1,10}|container:[0-9a-f]{12}:[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/;
export function parseIntegrationRoute(search: URLSearchParams): IntegrationRoute {
  const tab = search.get("tab"); const range = search.get("range");
  const metric = search.get("metric"); const entity = search.get("entity");
  return {
    tab: tab === "metrics" || tab === "configuration" ? tab : "overview",
    range: INTEGRATION_RANGES.includes(range as IntegrationMetricsRange) ? range as IntegrationMetricsRange : "1h",
    metric: metric && metricPattern.test(metric) ? metric : null,
    entity: entity && entity.length <= 160 && entityPattern.test(entity) ? entity : null,
  };
}
export function integrationRouteSearch(route: IntegrationRoute): URLSearchParams {
  const params = new URLSearchParams({ tab: route.tab, range: route.range });
  if (route.metric && metricPattern.test(route.metric)) params.set("metric", route.metric);
  if (route.entity && route.entity.length <= 160 && entityPattern.test(route.entity)) params.set("entity", route.entity);
  return params;
}
export function integrationDetailPath(vmId: string, instanceId: string): string {
  return `/vms/${encodeURIComponent(vmId)}/integrations/${encodeURIComponent(instanceId)}`;
}
export function vmIntegrationsPath(vmId: string): string { return `/vms/${encodeURIComponent(vmId)}?tab=integrations`; }

// Public metadata has no grouping field. This small reviewed native-ID mapping
// chooses entity dimensions only; it contains no expressions or metric math.
export function integrationEntityPrefix(kind: IntegrationKind, key: string): string | null {
  if (kind === "postgresql") return "db:";
  if (kind === "redis" && ["redis_keyspace_keys", "redis_keyspace_expires", "redis_keyspace_avg_ttl"].includes(key)) return "database:";
  if (kind === "docker" && key.startsWith("docker_container_")) return "container:";
  return null;
}
export function resolveIntegrationSelection(current: IntegrationMetricsCurrent, definition: IntegrationMetricDefinition, requestedEntity: string | null) {
  const prefix = integrationEntityPrefix(current.kind, definition.key);
  const entities = prefix ? current.entities.filter((entity) => entity.key.startsWith(prefix)) : [];
  // Disabled PostgreSQL current responses retain the server's exact database on
  // matching null-valued readings, even when the entity list is empty.
  if (current.kind === "postgresql" && current.entities.length === 0) {
    const reportedEntity = current.readings.find((reading) => reading.key === definition.key && reading.entityKey?.startsWith("db:"))?.entityKey;
    if (reportedEntity) entities.push({ key: reportedEntity, label: reportedEntity.slice(3) });
  }
  const entity = prefix ? entities.find((candidate) => candidate.key === requestedEntity) ?? entities[0] : undefined;
  return { entityKey: entity?.key ?? null, entities, canChart: current.dataState !== "unsupported" && definition.chart && (!prefix || Boolean(entity)), requiresEntity: Boolean(prefix) };
}
