export type SupportedAgentOs = "linux" | "windows";
export type IntegrationKind = "redis" | "postgresql" | "mysql" | "nginx" | "docker";
export type MonitoringTlsSettings = { tls: boolean; tlsCaPath?: string; tlsCertPath?: string; tlsKeyPath?: string };
export type IntegrationSettings = {
  redis: MonitoringTlsSettings & { host: string; port: number };
  postgresql: { host: string; port: number; database: string; sslMode: "disable" | "verify-full"; tlsCaPath?: string; tlsCertPath?: string; tlsKeyPath?: string };
  mysql: MonitoringTlsSettings & { host: string; port: number };
  nginx: MonitoringTlsSettings & { statusUrl: string; oauthTokenUrl?: string };
  docker: { endpoint: string; acknowledgePrivilegedAccess: true };
};
export type IntegrationInstance = {
  [K in IntegrationKind]: { id: string; kind: K; enabled: boolean; intervalSeconds: number; settings: IntegrationSettings[K] }
}[IntegrationKind];
export type MonitoringDefinition = {
  schemaVersion: 1;
  profileKey: "telegraf-native-v1";
  host: { intervalSeconds: number };
  integrations: IntegrationInstance[];
};
export type MonitoringSecretField = "username" | "password" | "tlsKeyPassword" | "oauthClientId" | "oauthClientSecret";
export type SecretPatch = { action: "keep" } | { action: "set"; value: string } | { action: "clear" };
export type MonitoringSecretPatches = Record<string, Partial<Record<MonitoringSecretField, SecretPatch>>>;
export type MonitoringSaveInput = { expectedVersion: number; definition: MonitoringDefinition; secrets: MonitoringSecretPatches };
export type MonitoringConfigView = {
  managed: boolean;
  version: number | null;
  definition: MonitoringDefinition | null;
  secretConfigured: Record<string, Partial<Record<MonitoringSecretField, boolean>>>;
};
export type IntegrationObservation = {
  instanceId: string;
  state: "observed" | "stale" | "unknown" | "disabled";
  lastSampleAt: string | null;
  availability: "available" | "disabled" | "unavailable" | "unsupported";
  freshnessSeconds: number | null;
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
  rejectedHash: string | null;
  configState: "pending" | "applied" | "rejected" | "unknown";
  lastAppliedAt: string | null;
  lastControlContactAt: string | null;
  rejectedError: string | null;
  integrations: IntegrationObservation[];
};
export type IntegrationCatalogEntry = {
  kind: IntegrationKind;
  title: string;
  plugin: IntegrationKind;
  supportedOs: SupportedAgentOs[];
  compatibility: string;
  settingsFields: string[];
  secretFields: MonitoringSecretField[];
  fields: string[];
  tags: string[];
  warning?: string;
};
export type MonitoringCatalog = {
  host: {
    profileKey: "telegraf-native-v1";
    compatibility: string;
    supportedOs: SupportedAgentOs[];
    interval: { default: number; minimum: number; maximum: number };
    runtimeVerification: "UNVERIFIED";
    inputs: Record<string, Record<string, unknown>>;
    system: Record<SupportedAgentOs, Record<string, unknown>>;
  };
  integrations: IntegrationCatalogEntry[];
};

// Docker's acknowledgement starts false in the local draft; only a validated save
// may construct the API's literal true. Raw credential patches live locally only.
export type IntegrationDraft = Exclude<IntegrationInstance, { kind: "docker" }> | {
  id: string; kind: "docker"; enabled: boolean; intervalSeconds: number;
  settings: { endpoint: string; acknowledgePrivilegedAccess: boolean };
};
export type MonitoringDraft = Omit<MonitoringDefinition, "integrations"> & { integrations: IntegrationDraft[] };
export type MonitoringFieldError = { fieldId: string; message: string };
