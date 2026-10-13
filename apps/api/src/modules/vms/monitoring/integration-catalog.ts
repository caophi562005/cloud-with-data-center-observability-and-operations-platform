import { isIP } from 'node:net';
import { z } from 'zod';
import type { IntegrationKind, MonitoringSecretField, SupportedAgentOs } from './monitoring.types.js';

export const MONITORING_PROFILE_KEY = 'telegraf-native-v1' as const;
export const TELEGRAF_VERSION = '1.40.1' as const;
export const MAX_INTEGRATION_INSTANCES = 16;
export const MAX_MONITORING_CONFIG_BYTES = 256 * 1024;
export const monitoringIntervalSchema = z.number().int().min(15).max(3600).default(30);
export const monitoringInstanceIdSchema = z.uuid().transform((id) => id.toLowerCase());

// Endpoint parts, not DSNs. A single hostname/IP cannot smuggle driver options.
const host = z.string().min(1).max(253).refine((value) =>
  isIP(value) !== 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value),
);
const port = (value: number) => z.number().int().min(1).max(65535).default(value);
const localPath = z.string().min(1).max(1024).refine((value) =>
  !/[\x00-\x1f\x7f$]/.test(value) && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)),
);

export function isSafeMonitoringUrl(value: string, protocols: readonly string[] = ['https:']): boolean {
  try {
    const url = new URL(value);
    // No userinfo, query (including secret-bearing query), fragment or env expansion.
    return protocols.includes(url.protocol) && Boolean(url.hostname) &&
      !url.username && !url.password && !/[?#\x00-\x20\x7f$]/.test(value) &&
      !/%24/i.test(value) && !url.pathname.includes('@');
  } catch {
    return false;
  }
}
const endpoint = (protocols: readonly string[]) => z.string().min(1).max(2048)
  .refine((value) => isSafeMonitoringUrl(value, protocols))
  .transform((value) => new URL(value).toString());
export const trustedMonitoringUrlSchema = endpoint(['https:']);
const tlsPaths = {
  tlsCaPath: localPath.optional(),
  tlsCertPath: localPath.optional(),
  tlsKeyPath: localPath.optional(),
};
const tlsSettings = { tls: z.boolean().default(false), ...tlsPaths };
type TlsPaths = { tlsCaPath?: string; tlsCertPath?: string; tlsKeyPath?: string };
function validTlsPaths(settings: TlsPaths, enabled: boolean): boolean {
  return Boolean(settings.tlsCertPath) === Boolean(settings.tlsKeyPath) &&
    (enabled || !Object.values(settings).some(Boolean));
}
const tlsRefine = (settings: TlsPaths & { tls: boolean }) => validTlsPaths({
  tlsCaPath: settings.tlsCaPath, tlsCertPath: settings.tlsCertPath, tlsKeyPath: settings.tlsKeyPath,
}, settings.tls);

export const integrationSettingsSchemas = {
  redis: z.object({ host, port: port(6379), ...tlsSettings }).strict().refine(tlsRefine),
  postgresql: z.object({
    host, port: port(5432), database: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
    sslMode: z.enum(['disable', 'verify-full']).default('verify-full'), ...tlsPaths,
  }).strict().refine((settings) => validTlsPaths({
    tlsCaPath: settings.tlsCaPath, tlsCertPath: settings.tlsCertPath, tlsKeyPath: settings.tlsKeyPath,
  }, settings.sslMode === 'verify-full')),
  mysql: z.object({ host, port: port(3306), ...tlsSettings }).strict().refine(tlsRefine),
  nginx: z.object({
    statusUrl: endpoint(['http:', 'https:']), oauthTokenUrl: endpoint(['https:']).optional(), ...tlsSettings,
  }).strict().refine(tlsRefine).refine((settings) =>
    settings.statusUrl.startsWith('https:') === settings.tls &&
    (!settings.oauthTokenUrl || settings.tls),
  ),
  docker: z.object({
    endpoint: z.enum(['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine']),
    acknowledgePrivilegedAccess: z.literal(true),
  }).strict(),
} as const;

export type IntegrationCatalogEntry = {
  kind: IntegrationKind;
  title: string;
  plugin: IntegrationKind;
  supportedOs: readonly SupportedAgentOs[];
  compatibility: typeof TELEGRAF_VERSION;
  settingsFields: readonly string[];
  secretFields: readonly MonitoringSecretField[];
  fields: readonly string[];
  tags: readonly string[];
  warning?: string;
};
const supportedOs = ['linux', 'windows'] as const;
const commonTlsFields = ['tls', 'tlsCaPath', 'tlsCertPath', 'tlsKeyPath'] as const;
export const INTEGRATION_CATALOG = {
  redis: { kind: 'redis', title: 'Redis', plugin: 'redis', supportedOs, compatibility: TELEGRAF_VERSION,
    settingsFields: ['host', 'port', ...commonTlsFields], secretFields: ['username', 'password', 'tlsKeyPassword'],
    fields: ['clients', 'used_memory'], tags: ['integration_instance_id'] },
  postgresql: { kind: 'postgresql', title: 'PostgreSQL', plugin: 'postgresql', supportedOs, compatibility: TELEGRAF_VERSION,
    settingsFields: ['host', 'port', 'database', 'sslMode', 'tlsCaPath', 'tlsCertPath', 'tlsKeyPath'],
    secretFields: ['username', 'password'], fields: ['numbackends'], tags: ['integration_instance_id', 'db'] },
  mysql: { kind: 'mysql', title: 'MySQL / MariaDB', plugin: 'mysql', supportedOs, compatibility: TELEGRAF_VERSION,
    settingsFields: ['host', 'port', ...commonTlsFields], secretFields: ['username', 'password', 'tlsKeyPassword'],
    fields: ['threads_connected'], tags: ['integration_instance_id'] },
  nginx: { kind: 'nginx', title: 'Nginx stub status', plugin: 'nginx', supportedOs, compatibility: TELEGRAF_VERSION,
    settingsFields: ['statusUrl', 'oauthTokenUrl', ...commonTlsFields],
    secretFields: ['oauthClientId', 'oauthClientSecret', 'tlsKeyPassword'], fields: ['active'], tags: ['integration_instance_id'],
    warning: 'Native Nginx supports OAuth client credentials and mutual TLS; Basic Auth URL userinfo is not supported by this template.' },
  docker: { kind: 'docker', title: 'Docker engine', plugin: 'docker', supportedOs, compatibility: TELEGRAF_VERSION,
    settingsFields: ['endpoint', 'acknowledgePrivilegedAccess'], secretFields: [], fields: ['n_containers_running'],
    tags: ['integration_instance_id'], warning: 'Local Docker socket access grants administrative container/host privileges. Explicit acknowledgement is required.' },
} as const satisfies Record<IntegrationKind, IntegrationCatalogEntry>;

// Source-derived contracts; runtime collection/serialization is still UNVERIFIED.
export const HOST_MONITORING_CATALOG = {
  profileKey: MONITORING_PROFILE_KEY, compatibility: TELEGRAF_VERSION, supportedOs,
  interval: { default: 30, minimum: 15, maximum: 3600 },
  runtimeVerification: 'UNVERIFIED',
  inputs: {
    cpu: { percpu: false, totalcpu: true, collect_cpu_time: false, report_active: false, core_tags: false,
      fieldpass: ['usage_idle'], taginclude: ['cpu'] },
    mem: { collect_extended: false, fieldpass: ['available', 'total'], tagexclude: ['*'] },
    disk: { fieldpass: ['free', 'total'], taginclude: ['path', 'device', 'fstype', 'mode'],
      ignore_fs: ['tmpfs', 'devtmpfs', 'devfs', 'iso9660', 'overlay', 'aufs', 'squashfs'] },
    net: { fieldpass: ['bytes_recv', 'bytes_sent'], taginclude: ['interface'] },
    internal: { collect_memstats: false, collect_gostats: false, per_instance: false,
      namepass: ['internal_agent'], fieldpass: ['metrics_gathered'], tagexclude: ['*'] },
  },
  system: {
    linux: { include: ['load', 'uptime'], fieldpass: ['load1', 'uptime'], tagexclude: ['*'] },
    windows: { include: ['uptime'], fieldpass: ['uptime'], tagexclude: ['*'] },
  },
} as const;

export function getMonitoringCatalog() {
  return { host: HOST_MONITORING_CATALOG, integrations: Object.values(INTEGRATION_CATALOG) };
}
