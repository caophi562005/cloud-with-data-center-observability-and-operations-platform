import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  INTEGRATION_CATALOG, MAX_INTEGRATION_INSTANCES, MAX_MONITORING_CONFIG_BYTES,
  integrationSettingsSchemas, monitoringInstanceIdSchema, monitoringIntervalSchema,
} from './integration-catalog.js';
import type {
  IntegrationInstance, MonitoringDefinition, MonitoringSecretPatches,
  MonitoringSaveInput, MonitoringSecretField, MonitoringSecretMetadata, MonitoringSecrets, SupportedAgentOs,
} from './monitoring.types.js';

const invalid = () => new BadRequestException('Invalid monitoring configuration');
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const secretFields: readonly MonitoringSecretField[] = ['username', 'password', 'tlsKeyPassword', 'oauthClientId', 'oauthClientSecret'];

// JSON-shaped data only, bounded before schema traversal; do not echo keys or values.
export function assertMonitoringData(input: unknown): void {
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) throw invalid();
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid();
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) throw invalid();
      visit(item, depth + 1);
    }
  };
  visit(input, 0);
  const json = JSON.stringify(input);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_MONITORING_CONFIG_BYTES) throw invalid();
}

const common = { id: monitoringInstanceIdSchema, enabled: z.boolean(), intervalSeconds: monitoringIntervalSchema };
const definitionSchema = z.object({
  schemaVersion: z.literal(1), profileKey: z.literal('telegraf-native-v1'),
  host: z.object({ intervalSeconds: monitoringIntervalSchema }).strict(),
  integrations: z.array(z.discriminatedUnion('kind', [
    z.object({ ...common, kind: z.literal('redis'), settings: integrationSettingsSchemas.redis }).strict(),
    z.object({ ...common, kind: z.literal('postgresql'), settings: integrationSettingsSchemas.postgresql }).strict(),
    z.object({ ...common, kind: z.literal('mysql'), settings: integrationSettingsSchemas.mysql }).strict(),
    z.object({ ...common, kind: z.literal('nginx'), settings: integrationSettingsSchemas.nginx }).strict(),
    z.object({ ...common, kind: z.literal('docker'), settings: integrationSettingsSchemas.docker }).strict(),
  ])).max(MAX_INTEGRATION_INSTANCES),
}).strict();

export function validateMonitoringDefinition(input: unknown, os: SupportedAgentOs): MonitoringDefinition {
  try {
    assertMonitoringData(input);
    if (os !== 'linux' && os !== 'windows') throw invalid();
    const definition = definitionSchema.parse(input);
    const ids = new Set<string>();
    for (const instance of definition.integrations) {
      if (ids.has(instance.id) || !INTEGRATION_CATALOG[instance.kind].supportedOs.includes(os)) throw invalid();
      ids.add(instance.id);
      if (instance.kind === 'docker' && instance.settings.endpoint !== (os === 'linux'
        ? 'unix:///var/run/docker.sock' : 'npipe:////./pipe/docker_engine')) throw invalid();
      for (const [key, value] of Object.entries(instance.settings)) {
        if (key.endsWith('Path') && typeof value === 'string' && !(os === 'linux'
          ? value.startsWith('/') : /^[A-Za-z]:[\\/]/.test(value))) throw invalid();
      }
    }
    return definition;
  } catch {
    throw invalid();
  }
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonicalId(id: string): string {
  const parsed = monitoringInstanceIdSchema.parse(id);
  // Map keys must already be canonical to avoid silent duplicate entries.
  if (parsed !== id) throw invalid();
  return parsed;
}

export function validateMonitoringSecrets(input: unknown): MonitoringSecrets {
  try {
    assertMonitoringData(input);
    if (!isPlainMap(input) || Object.keys(input).length > MAX_INTEGRATION_INSTANCES) throw invalid();
    const result: MonitoringSecrets = {};
    for (const [id, values] of Object.entries(input)) {
      canonicalId(id);
      if (!isPlainMap(values) || Object.keys(values).length > secretFields.length) throw invalid();
      result[id] = {};
      for (const [key, value] of Object.entries(values)) {
        if (!secretFields.includes(key as MonitoringSecretField) || typeof value !== 'string' ||
          !value.trim() || Buffer.byteLength(value, 'utf8') > (key === 'username' || key === 'oauthClientId' ? 256 : 4096) ||
          /[\x00\x7f]/.test(value) || /^[*•●]+$/.test(value.trim()) ||
          /^(?:\[REDACTED\]|<redacted>|<unchanged>|<masked>|__MASKED__)$/i.test(value.trim()) ||
          value.includes('__OPSGRID_') || value.includes('@{')) throw invalid();
        result[id][key] = value;
      }
    }
    return result;
  } catch {
    throw invalid();
  }
}

const secretPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('set'), value: z.string() }).strict(),
  z.object({ action: z.literal('clear') }).strict(),
]);

export function validateMonitoringSecretPatches(input: unknown): MonitoringSecretPatches {
  try {
    assertMonitoringData(input);
    if (!isPlainMap(input) || Object.keys(input).length > MAX_INTEGRATION_INSTANCES) throw invalid();
    const result: MonitoringSecretPatches = {};
    for (const [id, fields] of Object.entries(input)) {
      canonicalId(id);
      if (!isPlainMap(fields) || Object.keys(fields).length > secretFields.length) throw invalid();
      result[id] = {};
      for (const [field, raw] of Object.entries(fields)) {
        if (!secretFields.includes(field as MonitoringSecretField)) throw invalid();
        const patch = secretPatchSchema.parse(raw);
        if (patch.action === 'set') validateMonitoringSecrets({ [id]: { [field]: patch.value } });
        result[id][field] = patch;
      }
    }
    return result;
  } catch {
    throw invalid();
  }
}

function assertInstanceSecrets(instance: IntegrationInstance, secrets: Record<string, string>): void {
  const allowed: readonly string[] = INTEGRATION_CATALOG[instance.kind].secretFields;
  if (Object.keys(secrets).some((field) => !allowed.includes(field))) throw invalid();
  if ('tlsKeyPassword' in secrets && (!('tlsKeyPath' in instance.settings) || !instance.settings.tlsKeyPath)) throw invalid();
  if (instance.kind === 'mysql' && ((secrets.username && /[:@/\\\s]/.test(secrets.username)) ||
    (secrets.password && (!secrets.username || /[?&]tls=custom&/.test(secrets.password))))) throw invalid();
  if (instance.kind === 'nginx') {
    if (Boolean(secrets.oauthClientId) !== Boolean(secrets.oauthClientSecret) ||
      Boolean(instance.settings.oauthTokenUrl) !== Boolean(secrets.oauthClientId)) throw invalid();
  }
}

// Retain omitted fields; remove deleted instances; clear only explicit allowlisted fields.
export function mergeMonitoringSecrets(
  definition: MonitoringDefinition, current: MonitoringSecrets, patches: MonitoringSecretPatches = {},
): MonitoringSecrets {
  try {
    const previous = validateMonitoringSecrets(current);
    const changes = validateMonitoringSecretPatches(patches);
    assertPatchFields(definition, changes);
    const result: MonitoringSecrets = {};
    for (const instance of definition.integrations) {
      const values = { ...(previous[instance.id] ?? {}) };
      for (const [field, patch] of Object.entries(changes[instance.id] ?? {})) {
        if (patch.action === 'set') values[field] = patch.value;
        if (patch.action === 'clear') delete values[field];
      }
      assertInstanceSecrets(instance, values);
      if (Object.keys(values).length) result[instance.id] = values;
    }
    return result;
  } catch {
    throw invalid();
  }
}

function assertPatchFields(definition: MonitoringDefinition, patches: MonitoringSecretPatches): void {
  const instances = new Map(definition.integrations.map((instance) => [instance.id, instance]));
  for (const [id, fields] of Object.entries(patches)) {
    const instance = instances.get(id);
    if (!instance) throw invalid();
    const allowed: readonly string[] = INTEGRATION_CATALOG[instance.kind].secretFields;
    if (Object.keys(fields).some((field) => !allowed.includes(field))) throw invalid();
  }
}

export function validateMonitoringSaveInput(input: unknown, os: SupportedAgentOs): MonitoringSaveInput {
  try {
    assertMonitoringData(input);
    const envelope = z.object({
      expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), definition: z.unknown(),
      secrets: z.record(z.string(), z.unknown()),
    }).strict().parse(input);
    const definition = validateMonitoringDefinition(envelope.definition, os);
    const secrets = validateMonitoringSecretPatches(envelope.secrets);
    // Validate patch allowlists without requiring a complete credential pair before merge.
    assertPatchFields(definition, secrets);
    return { expectedVersion: envelope.expectedVersion, definition, secrets };
  } catch {
    throw invalid();
  }
}

export function monitoringSecretMetadata(definition: MonitoringDefinition, secrets: MonitoringSecrets): MonitoringSecretMetadata {
  const validated = validateMonitoringSecrets(secrets);
  const metadata: MonitoringSecretMetadata = {};
  for (const instance of definition.integrations) {
    metadata[instance.id] = Object.fromEntries(INTEGRATION_CATALOG[instance.kind].secretFields.map((field) =>
      [field, Boolean(validated[instance.id]?.[field])],
    ));
  }
  return metadata;
}
