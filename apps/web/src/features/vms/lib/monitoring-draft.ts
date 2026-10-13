import type {
  IntegrationDraft, IntegrationKind, MonitoringCatalog, MonitoringConfigView,
  MonitoringDefinition, MonitoringDraft, MonitoringFieldError, MonitoringSecretPatches, SupportedAgentOs,
} from "../monitoring.types";

export const MAX_INTEGRATIONS = 16;
export const monitoringFieldId = (id: string, field: string) => `monitoring-${id}-${field}`;

export function newIntegration(kind: IntegrationKind, os: SupportedAgentOs, intervalSeconds: number): IntegrationDraft {
  const common = { id: crypto.randomUUID(), enabled: true, intervalSeconds };
  switch (kind) {
    case "redis": return { ...common, kind, settings: { host: "localhost", port: 6379, tls: false } };
    case "postgresql": return { ...common, kind, settings: { host: "localhost", port: 5432, database: "postgres", sslMode: "verify-full" } };
    case "mysql": return { ...common, kind, settings: { host: "localhost", port: 3306, tls: false } };
    case "nginx": return { ...common, kind, settings: { statusUrl: "http://localhost/nginx_status", tls: false } };
    case "docker": return { ...common, kind, settings: { endpoint: os === "linux" ? "unix:///var/run/docker.sock" : "npipe:////./pipe/docker_engine", acknowledgePrivilegedAccess: false } };
  }
}
export function draftFromDefinition(definition: MonitoringDefinition): MonitoringDraft {
  return structuredClone(definition);
}
export function definitionFromDraft(draft: MonitoringDraft): MonitoringDefinition {
  return { ...draft, integrations: draft.integrations.map((item) => item.kind === "docker"
    ? { ...item, settings: { ...item.settings, acknowledgePrivilegedAccess: true } } : item) };
}

function safeUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value);
    return value.length <= 2048 && protocols.includes(url.protocol) && Boolean(url.hostname) &&
      !url.username && !url.password && !/[?#\x00-\x20\x7f$]/.test(value) && !/%24/i.test(value) && !url.pathname.includes("@");
  } catch { return false; }
}
function validHost(value: string): boolean {
  // Hostname/IPv4 or bare IPv6, never a DSN/URL. The server has authoritative IP validation.
  if (value.includes(":")) {
    try { return new URL(`http://[${value}]/`).hostname.length > 0; } catch { return false; }
  }
  return /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value);
}

export function validateMonitoringDraft(
  draft: MonitoringDraft, secrets: MonitoringSecretPatches, snapshot: MonitoringConfigView,
  catalog: MonitoringCatalog, os: SupportedAgentOs,
): MonitoringFieldError[] {
  const errors: MonitoringFieldError[] = [];
  const fail = (id: string, field: string, message: string) => errors.push({ fieldId: monitoringFieldId(id, field), message });
  const interval = (id: string, value: number) => {
    if (!Number.isInteger(value) || value < catalog.host.interval.minimum || value > catalog.host.interval.maximum)
      fail(id, "interval", `Gather interval must be a whole number from ${catalog.host.interval.minimum} to ${catalog.host.interval.maximum} seconds.`);
  };
  interval("host", draft.host.intervalSeconds);
  if (draft.integrations.length > MAX_INTEGRATIONS) fail("add", "kind", "Use no more than 16 integration instances.");
  for (const item of draft.integrations) {
    const entry = catalog.integrations.find((candidate) => candidate.kind === item.kind);
    if (!entry?.supportedOs.includes(os)) { fail(item.id, "interval", "This integration is not supported on the VM's operating system."); continue; }
    interval(item.id, item.intervalSeconds);
    const configured = (field: keyof NonNullable<MonitoringSecretPatches[string]>) => {
      const patch = secrets[item.id]?.[field];
      return patch?.action === "set" ? Boolean(patch.value.trim()) : patch?.action === "clear" ? false : Boolean(snapshot.secretConfigured[item.id]?.[field]);
    };
    for (const field of entry.secretFields) {
      const patch = secrets[item.id]?.[field];
      if (patch?.action === "set") {
        const value = patch.value;
        if (!value.trim()) fail(item.id, field, "Enter a replacement value or choose Keep; blank does not clear a credential.");
        else if (new TextEncoder().encode(value).length > (field === "username" || field === "oauthClientId" ? 256 : 4096) ||
          /[\x00\x7f]/.test(value) || /^[*•●]+$/.test(value.trim()) || /^(?:\[REDACTED\]|<redacted>|<unchanged>|<masked>|__MASKED__)$/i.test(value.trim()) || value.includes("__OPSGRID_") || value.includes("@{"))
          fail(item.id, field, "Enter a real supported credential, not a masked value or template; check its length.");
      }
    }
    if (item.kind === "docker") {
      if (!item.settings.acknowledgePrivilegedAccess) fail(item.id, "acknowledge", "Explicitly acknowledge Docker's administrative host privileges.");
      continue;
    }
    const settings = item.settings;
    if ("host" in settings) {
      if (!validHost(settings.host)) fail(item.id, "host", "Enter a single hostname or IP address, not a URL or connection string.");
      if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) fail(item.id, "port", "Port must be a whole number from 1 to 65535.");
    }
    if (item.kind === "postgresql" && (!/^[A-Za-z0-9_.-]+$/.test(item.settings.database) || item.settings.database.length > 128))
      fail(item.id, "database", "Enter a database name using letters, numbers, underscores, dots or hyphens (up to 128 characters).");
    const tls = item.kind === "postgresql" ? item.settings.sslMode === "verify-full" : "tls" in settings && settings.tls;
    for (const field of ["tlsCaPath", "tlsCertPath", "tlsKeyPath"] as const) {
      const value = settings[field];
      if (value && (value.length > 1024 || /[\x00-\x1f\x7f$]/.test(value) || !(os === "linux" ? value.startsWith("/") : /^[A-Za-z]:[\\/]/.test(value))))
        fail(item.id, field, "Use an absolute local path on this agent's OS, without control characters or environment expansion.");
      if (value && !tls) fail(item.id, field, "Enable TLS or remove this TLS path explicitly.");
    }
    if (Boolean(settings.tlsCertPath) !== Boolean(settings.tlsKeyPath)) fail(item.id, "tlsCertPath", "Client certificate and key paths must be supplied together.");
    if (configured("tlsKeyPassword") && !settings.tlsKeyPath) fail(item.id, "tlsKeyPassword", "A key password requires a TLS key path; explicitly clear the credential if removing that path.");
    if (item.kind === "nginx") {
      if (!safeUrl(item.settings.statusUrl, ["http:", "https:"])) fail(item.id, "statusUrl", "Enter an HTTP/HTTPS stub-status URL without userinfo, query credentials, query or fragment.");
      if (item.settings.statusUrl.startsWith("https:") !== item.settings.tls) fail(item.id, "tls", "TLS must match the status URL: enabled for HTTPS, disabled for HTTP.");
      if (item.settings.oauthTokenUrl && (!safeUrl(item.settings.oauthTokenUrl, ["https:"]) || !item.settings.tls)) fail(item.id, "oauthTokenUrl", "OAuth requires HTTPS token and status URLs with TLS enabled, without query or userinfo.");
      if (Boolean(item.settings.oauthTokenUrl) !== configured("oauthClientId") || configured("oauthClientId") !== configured("oauthClientSecret"))
        fail(item.id, "oauthClientId", "Provide both OAuth client ID and secret if using a token URL; otherwise explicitly clear both credentials.");
    }
    if (item.kind === "mysql") {
      const username = secrets[item.id]?.username;
      const password = secrets[item.id]?.password;
      if (username?.action === "set" && /[:@/\\\s]/.test(username.value)) fail(item.id, "username", "MySQL username cannot contain whitespace or connection-string delimiters.");
      if (configured("password") && !configured("username")) fail(item.id, "password", "MySQL password requires a username.");
      if (password?.action === "set" && /[?&]tls=custom&/.test(password.value)) fail(item.id, "password", "This password contains an unsupported driver-options sequence.");
    }
  }
  return errors;
}
