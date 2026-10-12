import { registerAs } from '@nestjs/config';
import { parseEnv, type Env, DEFAULT_VM_HEALTH_POLICY } from './env.schema.js';
export type VmHealthPolicy = {
  [K in keyof typeof DEFAULT_VM_HEALTH_POLICY]: number;
};

export type MetricsAuth =
  | { mode: 'none' }
  | { mode: 'basic'; username: string; token: string }
  | { mode: 'bearer'; token: string };

export interface MetricsQueryConfig {
  /** Prometheus base URL (Grafana Cloud: https://HOST/api/prom). */
  baseUrl: string;
  /** Only the selected query credentials; never includes a write token. */
  auth: MetricsAuth;
}

export interface MetricsConfig {
  query: MetricsQueryConfig | null;
  health?: VmHealthPolicy;
}

export function createMetricsConfig(environment: Env): MetricsConfig {
  const {
    METRICS_QUERY_URL,
    METRICS_QUERY_AUTH_MODE,
    METRICS_USERNAME,
    METRICS_QUERY_TOKEN,
  } = environment;

  const health: VmHealthPolicy = {
    staleSeconds: environment.VM_DISCONNECTED_AFTER_SECONDS,
    cpuWarning: environment.VM_HEALTH_CPU_WARNING_PERCENT,
    memoryWarning: environment.VM_HEALTH_MEMORY_WARNING_PERCENT,
    diskWarning: environment.VM_HEALTH_DISK_WARNING_PERCENT,
    critical: environment.VM_HEALTH_CRITICAL_PERCENT,
  };
  if (!METRICS_QUERY_URL) {
    return { query: null, health };
  }

  // Env validation guarantees the credentials required by the selected mode.
  const auth: MetricsAuth =
    METRICS_QUERY_AUTH_MODE === 'none'
      ? { mode: 'none' }
      : METRICS_QUERY_AUTH_MODE === 'bearer'
        ? { mode: 'bearer', token: METRICS_QUERY_TOKEN! }
        : {
            mode: 'basic',
            username: METRICS_USERNAME!,
            token: METRICS_QUERY_TOKEN!,
          };

  return {
    health,
    query: {
      baseUrl: METRICS_QUERY_URL.replace(/\/+$/, ''),
      auth,
    },
  };
}

export const metricsConfig = registerAs('metrics', (): MetricsConfig =>
  createMetricsConfig(parseEnv()),
);

export default metricsConfig;
