export type SupportedAgentOs = 'linux' | 'windows';
export type IntegrationKind =
  'redis' | 'postgresql' | 'mysql' | 'nginx' | 'docker';

export type AgentIdentity = {
  organizationId: string;
  vmId: string;
  agentId: string;
};

export type MonitoringTlsSettings = {
  tls: boolean;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
};

export type IntegrationSettings = {
  redis: MonitoringTlsSettings & { host: string; port: number };
  postgresql: {
    host: string;
    port: number;
    database: string;
    sslMode: 'disable' | 'verify-full';
    tlsCaPath?: string;
    tlsCertPath?: string;
    tlsKeyPath?: string;
  };
  mysql: MonitoringTlsSettings & { host: string; port: number };
  nginx: MonitoringTlsSettings & { statusUrl: string; oauthTokenUrl?: string };
  docker: {
    endpoint: string;
    acknowledgePrivilegedAccess: true;
    collectContainerMetrics?: boolean;
    containerNames?: string[];
  };
};

export type IntegrationInstance = {
  [K in IntegrationKind]: {
    id: string;
    kind: K;
    enabled: boolean;
    intervalSeconds: number;
    settings: IntegrationSettings[K];
  };
}[IntegrationKind];

export type MonitoringSecretField =
  | 'username'
  | 'password'
  | 'tlsKeyPassword'
  | 'oauthClientId'
  | 'oauthClientSecret';
export type MonitoringSecrets = Record<string, Record<string, string>>;
export type SecretPatch =
  | { action: 'keep' }
  | { action: 'set'; value: string }
  | { action: 'clear' };
export type MonitoringSecretPatches = Record<string, Record<string, SecretPatch>>;

export type MonitoringSaveInput = {
  expectedVersion: number;
  definition: MonitoringDefinition;
  secrets: MonitoringSecretPatches;
};

export type MonitoringSecretMetadata = Record<
  string,
  Partial<Record<MonitoringSecretField, boolean>>
>;

export type MonitoringRenderContext = {
  os: SupportedAgentOs;
  apiOrigin: string;
  metricsWriteUrl: string;
};

export type RenderedConfig = {
  toml: string;
  hash: string;
  byteLength: number;
  schemaVersion: 1;
  profileKey: 'telegraf-native-v1';
};

export type MonitoringDefinition = {
  schemaVersion: 1;
  profileKey: 'telegraf-native-v1';
  host: { intervalSeconds: number };
  integrations: IntegrationInstance[];
};

export type AgentConfigEnvelope = {
  schemaVersion: 1;
  version: number;
  hash: string;
  profileKey: 'telegraf-native-v1';
  toml: string;
};

export type AgentApplyReport = {
  version: number;
  hash: string;
  result: 'applied' | 'rejected';
  errorCode?: string;
  errorMessage?: string;
};

export type NativeHeartbeatInput = {
  id: string;
  version: string;
  schema: 1;
  last?: number;
  statistics?: { errors: number; warnings: number; metrics: number };
  status?: 'OK' | 'WARN' | 'FAIL' | 'UNDEFINED';
};

export type ConfigState = 'pending' | 'applied' | 'rejected' | 'unknown';
export type IntegrationObservation = {
  instanceId: string;
  state: 'observed' | 'stale' | 'unknown' | 'disabled';
  lastSampleAt: string | null;
  availability: 'available' | 'disabled' | 'unavailable' | 'unsupported';
  freshnessSeconds: number | null;
  // Evidence is for a stable instance ID only, not current endpoint/settings,
  // desired revision application, service health or reachability.
};

export type MonitoringConfigView = {
  managed: boolean;
  version: number | null;
  definition: MonitoringDefinition | null;
  secretConfigured: Record<string, Record<string, boolean>>;
};

export type AgentStatusView = {
  managed: boolean;
  agentId: string | null;
  collectorType: string | null;
  collectorVersion: string | null;
  buildId: string | null;
  desiredVersion: number | null;
  desiredHash: string | null;
  appliedVersion: number | null;
  appliedHash: string | null;
  rejectedVersion: number | null;
  // Only reconstructable for the current desired snapshot; no rejected hash column.
  rejectedHash: string | null;
  configState: ConfigState;
  lastAppliedAt: string | null;
  lastControlContactAt: string | null;
  rejectedError: string | null;
  integrations: IntegrationObservation[];
};

// Return a fresh aggregate; no shared mutable integration array between VMs.
export function initialMonitoringDefinition(): MonitoringDefinition {
  return {
    schemaVersion: 1,
    profileKey: 'telegraf-native-v1',
    host: { intervalSeconds: 30 },
    integrations: [],
  };
}
