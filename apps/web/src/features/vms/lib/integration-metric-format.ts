import { formatLocalDateTime } from "../../../lib/date-time";
import type { IntegrationMetricsCurrent, IntegrationMetricDefinition } from "../integration-metrics.types";
import type { IntegrationInstance, IntegrationKind } from "../monitoring.types";

export function integrationMetricValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}
export function integrationSampleTime(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? formatLocalDateTime(value, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "Not reported";
}
export const INTEGRATION_STATE_LABELS = { fresh: "Receiving metrics", stale: "Stale", "no-data": "No data", disabled: "Disabled", unsupported: "Unsupported", "not-applicable": "Not applicable" } as const;
export const INTEGRATION_TITLES: Record<IntegrationKind, string> = { redis: "Redis", postgresql: "PostgreSQL", mysql: "MySQL / MariaDB", nginx: "Nginx", docker: "Docker" };
export function integrationTarget(instance: IntegrationInstance): string {
  switch (instance.kind) {
    case "redis": case "mysql": return `${instance.settings.host}:${instance.settings.port}`;
    case "postgresql": return `${instance.settings.host}:${instance.settings.port} / ${instance.settings.database}`;
    case "nginx": return instance.settings.statusUrl;
    case "docker": return instance.settings.endpoint;
  }
}
const featured: Record<IntegrationKind, string[]> = {
  redis: ["redis_clients", "redis_used_memory", "redis_commands_per_second", "redis_cache_hit_percent"],
  postgresql: ["postgresql_numbackends", "postgresql_commits_per_second", "postgresql_rollbacks_per_second", "postgresql_cache_hit_percent"],
  mysql: ["mysql_threads_connected", "mysql_questions_per_second", "mysql_slow_queries_per_second", "mysql_buffer_hit_percent"],
  nginx: ["nginx_active", "nginx_requests_per_second", "nginx_reading", "nginx_waiting"],
  docker: ["docker_n_containers_running", "docker_container_cpu_usage_percent", "docker_container_mem_usage", "docker_container_net_rx_bytes_per_second"],
};
export function featuredIntegrationDefinitions(current: IntegrationMetricsCurrent): IntegrationMetricDefinition[] {
  // Windows exposes commit/private fields, never a made-up Linux memory ratio.
  const keys = current.kind === "docker" && !current.definitions.some((metric) => metric.key === "docker_container_mem_usage")
    ? featured.docker.map((key) => key === "docker_container_mem_usage" ? "docker_container_mem_commit_bytes" : key) : featured[current.kind];
  return keys.flatMap((key) => current.definitions.filter((metric) => metric.key === key && metric.chart)).slice(0, 4);
}
export function integrationReadError(statusCode: number, subject: string): string {
  return statusCode === 403 ? `Access denied to ${subject}.` : statusCode === 404 ? "VM or integration not found." : statusCode === 503 ? `${subject} unavailable (503). This is not an empty sample response.` : `${subject} could not be refreshed. Retained values are hidden until a successful read.`;
}
