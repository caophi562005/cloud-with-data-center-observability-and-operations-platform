import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { stringify } from 'smol-toml';
import {
  HOST_MONITORING_CATALOG, INTEGRATION_CATALOG, MAX_MONITORING_CONFIG_BYTES,
  trustedMonitoringUrlSchema,
} from './integration-catalog.js';
import { getNativeIntegrationProfile } from './integration-metric-profiles.js';
import { mergeMonitoringSecrets, validateMonitoringDefinition, validateMonitoringSecrets } from './monitoring.schema.js';
import { requireMonitoringSecretKey } from './monitoring-secrets.service.js';
import type {
  IntegrationInstance, MonitoringDefinition, MonitoringTlsSettings, RenderedConfig, SupportedAgentOs,
} from './monitoring.types.js';

export const AGENT_CREDENTIAL_MARKER = '__OPSGRID_AGENT_CREDENTIAL__';
export const AGENT_ID_MARKER = '__OPSGRID_AGENT_ID__';

type NativeTable = Record<string, unknown>;
function tlsOptions(settings: MonitoringTlsSettings, secrets: Record<string, string>): NativeTable {
  return {
    tls_enable: settings.tls, insecure_skip_verify: false,
    ...(settings.tlsCaPath ? { tls_ca: settings.tlsCaPath } : {}),
    ...(settings.tlsCertPath ? { tls_cert: settings.tlsCertPath } : {}),
    ...(settings.tlsKeyPath ? { tls_key: settings.tlsKeyPath } : {}),
    ...(secrets.tlsKeyPassword ? { tls_key_pwd: secrets.tlsKeyPassword } : {}),
  };
}
function authority(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}
// pgx keyword/value grammar: backslash and quote are escaped, never URI-encode a keyword DSN.
function pgValue(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}
function serviceOptions(instance: IntegrationInstance, secrets: Record<string, string>): NativeTable {
  switch (instance.kind) {
    case 'redis': {
      const options = instance.settings;
      return { servers: [`tcp://${authority(options.host, options.port)}`],
        ...tlsOptions(options, secrets), username: secrets.username ?? '', password: secrets.password ?? '' };
    }
    case 'postgresql': {
      const options = instance.settings;
      const parts: Record<string, string> = {
        host: options.host, port: String(options.port), dbname: options.database,
        user: secrets.username ?? 'postgres', password: secrets.password ?? '',
        sslmode: options.sslMode, connect_timeout: '5',
        ...(options.tlsCaPath ? { sslrootcert: options.tlsCaPath } : {}),
        ...(options.tlsCertPath ? { sslcert: options.tlsCertPath } : {}),
        ...(options.tlsKeyPath ? { sslkey: options.tlsKeyPath } : {}),
      };
      return { address: Object.entries(parts).map(([key, value]) => `${key}=${pgValue(value)}`).join(' '),
        databases: [options.database], prepared_statements: true, max_open: 1, max_idle: 1 };
    }
    case 'mysql': {
      const options = instance.settings;
      // go-sql-driver/mysql does NOT percent-decode passwords: FormatDSN emits raw
      // user:password before the LAST @. The validated user excludes delimiters.
      const auth = secrets.username ? `${secrets.username}:${secrets.password ?? ''}@` : '';
      const dsn = `${auth}tcp(${authority(options.host, options.port)})/?timeout=5s&tls=${options.tls ? 'custom' : 'false'}`;
      return { servers: [dsn], ...tlsOptions(options, secrets), metric_version: 2,
        gather_global_variables: false, gather_process_list: false, gather_user_statistics: false,
        gather_info_schema_auto_inc: false, gather_innodb_metrics: false, gather_slave_status: false,
        gather_replica_status: false, gather_all_slave_channels: false, gather_binary_logs: false,
        gather_table_io_waits: false, gather_table_lock_waits: false, gather_index_io_waits: false,
        gather_event_waits: false, gather_table_schema: false, gather_file_events_stats: false,
        gather_perf_events_statements: false, gather_perf_sum_per_acc_per_event: false };
    }
    case 'nginx': {
      const options = instance.settings;
      return { urls: [options.statusUrl], ...tlsOptions(options, secrets), timeout: '5s', use_system_proxy: false,
        ...(options.oauthTokenUrl ? { token_url: options.oauthTokenUrl,
          client_id: secrets.oauthClientId, client_secret: secrets.oauthClientSecret } : {}) };
    }
    case 'docker':
      return { endpoint: instance.settings.endpoint, gather_services: false,
        tag_env: [], docker_label_include: [], docker_label_exclude: ['*'], timeout: '5s' };
    default:
      throw new BadRequestException('Invalid monitoring configuration');
  }
}

// Canonical key order plus stable instance order. Telegraf expands env strings after
// TOML parsing; $$ protects literal dollar signs in credentials (not OS env export).
function canonicalNative(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('$', '$$');
  if (Array.isArray(value)) return value.map(canonicalNative);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalNative(item)]));
  return value;
}

export function monitoringHeartbeatUrl(apiOrigin: string): string {
  try {
    const validated = trustedMonitoringUrlSchema.parse(apiOrigin);
    const origin = new URL(validated);
    // AGENT_API_PUBLIC_URL is an origin, not a path-bearing base: never duplicate /api/v1.
    if (origin.pathname !== '/') throw new Error();
    return new URL('/api/v1/agent/heartbeat', origin).toString();
  } catch {
    throw new BadRequestException('Invalid monitoring endpoints');
  }
}

export function renderMonitoringConfig(
  definition: MonitoringDefinition, secrets: Record<string, Record<string, string>>,
  context: { os: SupportedAgentOs; apiOrigin: string; metricsWriteUrl: string },
): RenderedConfig {
  const key = requireMonitoringSecretKey();
  key.fill(0);
  try {
    if (!context || Object.keys(context).sort().join(',') !== 'apiOrigin,metricsWriteUrl,os') throw new Error();
    const validated = validateMonitoringDefinition(definition, context.os);
    const supplied = validateMonitoringSecrets(secrets);
    const ids = new Set(validated.integrations.map((instance) => instance.id));
    if (Object.keys(supplied).some((id) => !ids.has(id))) throw new Error();
    const credentials = mergeMonitoringSecrets(validated, supplied);
    const heartbeatUrl = monitoringHeartbeatUrl(context.apiOrigin);
    const metricsWriteUrl = new URL(trustedMonitoringUrlSchema.parse(context.metricsWriteUrl)).toString();
    const interval = `${validated.host.intervalSeconds}s`;
    const inputs: Record<string, NativeTable[]> = {};
    for (const [name, options] of Object.entries(HOST_MONITORING_CATALOG.inputs)) {
      // Delivery presence must stay fresh even when resource collection is infrequent.
      inputs[name] = [{ ...options, interval: name === 'internal' ? '60s' : interval }];
    }
    inputs.system = [{ ...HOST_MONITORING_CATALOG.system[context.os], interval }];
    for (const instance of [...validated.integrations].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
      if (!instance.enabled) continue;
      const entry = INTEGRATION_CATALOG[instance.kind];
      const profile = getNativeIntegrationProfile(instance, context.os);
      const block: NativeTable = {
        ...serviceOptions(instance, credentials[instance.id] ?? {}), ...profile.options,
        interval: `${instance.intervalSeconds}s`,
        fieldpass: [...profile.fields], namepass: [...profile.measurements], taginclude: [...profile.tags],
        tags: { integration_instance_id: instance.id },
      };
      (inputs[entry.plugin] ??= []).push(block);
    }
    const native = {
      agent: { interval, round_interval: true, collection_jitter: '0s', flush_interval: '30s', flush_jitter: '0s',
        metric_batch_size: 1000, metric_buffer_limit: 10000, omit_hostname: true, debug: false },
      inputs,
      outputs: {
        http: [{ url: metricsWriteUrl, method: 'POST', data_format: 'prometheusremotewrite',
          prometheus_string_as_label: false, use_batch_format: true, content_encoding: 'identity',
          non_retryable_statuscodes: [400, 413, 422], timeout: '5s', use_system_proxy: false,
          headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'snappy',
            'X-Prometheus-Remote-Write-Version': '0.1.0', Authorization: `Bearer ${AGENT_CREDENTIAL_MARKER}` } }],
        heartbeat: [{ url: heartbeatUrl, instance_id: AGENT_ID_MARKER, token: AGENT_CREDENTIAL_MARKER,
          interval: '60s', include: ['statistics'], timeout: '5s', use_system_proxy: false }],
      },
    };
    // Only encoder-produced TOML; no browser-authored TOML or extra tables accepted.
    const toml = stringify(canonicalNative(native) as Parameters<typeof stringify>[0]);
    const byteLength = Buffer.byteLength(toml, 'utf8');
    if (byteLength > MAX_MONITORING_CONFIG_BYTES) throw new Error();
    return { toml, hash: createHash('sha256').update(toml, 'utf8').digest('hex'), byteLength,
      schemaVersion: 1, profileKey: 'telegraf-native-v1' };
  } catch {
    throw new BadRequestException('Invalid monitoring configuration');
  }
}
