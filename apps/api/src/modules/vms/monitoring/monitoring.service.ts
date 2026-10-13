import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AgentCollectorType, AgentStatus } from '@prisma/client';
import { getMonitoringCatalog, MAX_MONITORING_CONFIG_BYTES } from './integration-catalog.js';
import { renderMonitoringConfig } from './integration-renderer.js';
import { validateAgentApplyReport, validateNativeHeartbeat } from './agent-control.schema.js';
import { MonitoringRepository, type MonitoringSnapshot } from './monitoring.repository.js';
import { MonitoringSecretsService } from './monitoring-secrets.service.js';
import { IntegrationObservationService } from './integration-observation.service.js';
import { mergeMonitoringSecrets, monitoringSecretMetadata, validateMonitoringDefinition, validateMonitoringSaveInput } from './monitoring.schema.js';
import type {
  AgentApplyReport, AgentConfigEnvelope, AgentIdentity, AgentStatusView, ConfigState,
  MonitoringConfigView, MonitoringDefinition, MonitoringSaveInput, MonitoringSecrets,
  NativeHeartbeatInput, RenderedConfig, SupportedAgentOs,
} from './monitoring.types.js';

// Task 5 wire contract: a quoted strong tag, with BOTH version and marker-TOML hash.
export function monitoringConfigEtag(config: Pick<AgentConfigEnvelope, 'version' | 'hash'>): string {
  return `"${config.version}-${config.hash}"`;
}

export const AGENT_APPLY_ERROR_MESSAGES = {
  CONFIG_HASH_MISMATCH: 'Agent configuration integrity check failed.',
  CONFIG_SCHEMA_UNSUPPORTED: 'Agent configuration schema is unsupported.',
  CONFIG_POLICY_REJECTED: 'Agent configuration policy check failed.',
  CONFIG_PARSE_FAILED: 'Agent could not parse the configuration.',
  CONFIG_START_FAILED: 'Agent could not start the candidate configuration.',
  CONFIG_APPLY_FAILED: 'Agent could not apply the candidate configuration.',
  CONFIG_REJECTED: 'Agent rejected the candidate configuration.',
} as const;

function sanitizedRejection(code?: string): string {
  const safeCode = code && Object.hasOwn(AGENT_APPLY_ERROR_MESSAGES, code)
    ? code as keyof typeof AGENT_APPLY_ERROR_MESSAGES : 'CONFIG_REJECTED';
  // Server-owned ASCII text only, well below 1024 UTF-8 bytes. Never use errorMessage.
  return `${safeCode}: ${AGENT_APPLY_ERROR_MESSAGES[safeCode]}`;
}

export function constructAgentConfigEnvelope(version: number, rendered: RenderedConfig): AgentConfigEnvelope {
  const envelope: AgentConfigEnvelope = {
    schemaVersion: 1, version, hash: rendered.hash,
    profileKey: 'telegraf-native-v1', toml: rendered.toml,
  };
  if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647 ||
    Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_MONITORING_CONFIG_BYTES) {
    throw new BadRequestException('Invalid monitoring configuration');
  }
  return envelope;
}

function managed(snapshot: MonitoringSnapshot): boolean {
  return snapshot.agent?.collectorType === AgentCollectorType.TELEGRAF &&
    snapshot.monitoringConfig?.schemaVersion === 1 &&
    snapshot.monitoringConfig.profileKey === 'telegraf-native-v1' &&
    (snapshot.os === 'linux' || snapshot.os === 'windows');
}

@Injectable()
export class MonitoringService {
  constructor(
    private readonly repository: MonitoringRepository,
    private readonly secrets: MonitoringSecretsService,
    private readonly observations: IntegrationObservationService,
  ) {}

  getCatalog() {
    return getMonitoringCatalog();
  }

  async getHumanConfig(org: string, vmId: string): Promise<MonitoringConfigView> {
    return this.repository.withLockedVm(org, vmId, async (snapshot) => {
      if (!managed(snapshot)) return { managed: false, version: null, definition: null, secretConfigured: {} };
      const current = this.current(snapshot);
      return this.humanView(snapshot.monitoringConfig!.version, current.definition, current.secrets);
    });
  }

  async save(org: string, vmId: string, input: MonitoringSaveInput): Promise<MonitoringConfigView> {
    return this.repository.withLockedVm(org, vmId, async (snapshot, transaction) => {
      // Legacy/unknown inventory is not implicitly enrolled or converted to native.
      if (!managed(snapshot)) throw new ConflictException('VM has no managed monitoring configuration');
      const validated = validateMonitoringSaveInput(input, snapshot.os as SupportedAgentOs);
      const version = snapshot.monitoringConfig!.version;
      if (validated.expectedVersion !== version || version >= 2_147_483_647) {
        throw new ConflictException('Monitoring configuration changed');
      }
      const current = this.current(snapshot);
      const merged = mergeMonitoringSecrets(validated.definition, current.secrets, validated.secrets);
      const rendered = renderMonitoringConfig(validated.definition, merged, this.secrets.getRenderContext(snapshot.os as SupportedAgentOs));
      constructAgentConfigEnvelope(version + 1, rendered);
      const identity = this.identity(snapshot);
      const ciphertext = Object.keys(merged).length ? this.secrets.encrypt(merged, identity) : null;
      await this.repository.saveConfig(transaction, org, vmId, version, validated.definition, ciphertext);
      return this.humanView(version + 1, validated.definition, merged);
    });
  }

  async getAgentConfig(identity: AgentIdentity, etag?: string): Promise<AgentConfigEnvelope | null> {
    return this.repository.withLockedVm(identity.organizationId, identity.vmId, async (snapshot, transaction) => {
      if (!managed(snapshot)) throw new NotFoundException('Managed monitoring configuration not found');
      const current = this.current(snapshot);
      const envelope = constructAgentConfigEnvelope(snapshot.monitoringConfig!.version, current.rendered);
      await this.repository.updateAgent(transaction, identity, { lastControlContactAt: new Date() });
      // Deliberately exact, single strong-tag matching. Weak tags, wildcard and
      // tag lists take the safe 200 path; they cannot suppress a new version.
      return etag === monitoringConfigEtag(envelope) ? null : envelope;
    }, identity);
  }

  async recordApply(identity: AgentIdentity, report: AgentApplyReport): Promise<void> {
    const validated = validateAgentApplyReport(report);
    await this.repository.withLockedVm(identity.organizationId, identity.vmId, async (snapshot, transaction) => {
      if (!managed(snapshot)) return;
      const version = snapshot.monitoringConfig!.version;
      if (validated.version !== version) return;
      const current = this.current(snapshot);
      if (validated.hash !== current.rendered.hash) return;
      const agent = snapshot.agent!;
      // A successful ACK wins for this snapshot. Duplicate applied/rejected
      // reports do not refresh apply timestamps or regress an applied version.
      if (agent.appliedConfigVersion === version && agent.appliedConfigHash === validated.hash) return;
      const now = new Date();
      if (validated.result === 'applied') {
        await this.repository.updateAgent(transaction, identity, {
          appliedConfigVersion: version, appliedConfigHash: validated.hash,
          appliedConfigAt: now, rejectedConfigVersion: null, rejectedConfigError: null,
          lastControlContactAt: now,
        });
      } else if (agent.rejectedConfigVersion !== version) {
        await this.repository.updateAgent(transaction, identity, {
          rejectedConfigVersion: version, rejectedConfigError: sanitizedRejection(validated.errorCode),
          lastControlContactAt: now,
        });
      }
    }, identity);
  }

  async recordHeartbeat(identity: AgentIdentity, body: NativeHeartbeatInput): Promise<void> {
    const validated = validateNativeHeartbeat(body);
    if (validated.id !== identity.agentId.toLowerCase()) throw new BadRequestException('Agent heartbeat identity mismatch');
    await this.repository.withLockedVm(identity.organizationId, identity.vmId, async (_snapshot, transaction) => {
      // Native version/statistics/last never select identity or update collector,
      // apply state, VM health or telemetry timestamps. Server clock only.
      await this.repository.updateAgent(transaction, identity, { lastControlContactAt: new Date() });
    }, identity);
  }

  async getAgentStatus(org: string, vmId: string): Promise<AgentStatusView> {
    const captured = await this.repository.withLockedVm(org, vmId, async (snapshot) => {
      const isManaged = managed(snapshot);
      const current = isManaged ? this.current(snapshot) : null;
      const agent = snapshot.agent;
      const desiredVersion = current ? snapshot.monitoringConfig!.version : null;
      const desiredHash = current?.rendered.hash ?? null;
      let configState: ConfigState = 'unknown';
      if (current && agent?.status === AgentStatus.ACTIVE) {
        configState = agent.appliedConfigVersion === desiredVersion && agent.appliedConfigHash === desiredHash
          ? 'applied' : agent.rejectedConfigVersion === desiredVersion ? 'rejected' : 'pending';
      }
      const instances = current?.definition.integrations ?? [];
      const view: AgentStatusView = {
        managed: isManaged, agentId: agent?.id ?? null,
        collectorType: agent?.collectorType ?? null, collectorVersion: agent?.collectorVersion ?? null,
        buildId: agent?.buildId ?? null, desiredVersion, desiredHash,
        appliedVersion: agent?.appliedConfigVersion ?? null, appliedHash: agent?.appliedConfigHash ?? null,
        rejectedVersion: agent?.rejectedConfigVersion ?? null,
        rejectedHash: current && agent?.rejectedConfigVersion === desiredVersion ? desiredHash : null,
        configState, lastAppliedAt: agent?.appliedConfigAt?.toISOString() ?? null,
        lastControlContactAt: agent?.lastControlContactAt?.toISOString() ?? null,
        rejectedError: agent?.rejectedConfigError
          ? sanitizedRejection(agent.rejectedConfigError.split(':', 1)[0]) : null,
        integrations: instances.map((instance) => ({
          instanceId: instance.id, state: instance.enabled ? 'unknown' : 'disabled', lastSampleAt: null,
          availability: 'unsupported', freshnessSeconds: null,
        })),
      };
      // Capture only server-owned identity/nonsecret definitions. All metric IO
      // is BELOW the awaited transaction, never while holding its VM row lock.
      return { view, instances, identity: isManaged && agent?.status === AgentStatus.ACTIVE ? this.identity(snapshot) : null };
    });
    if (captured.identity) captured.view.integrations = await this.observations.observe(captured.identity, captured.instances);
    return captured.view;
  }

  private identity(snapshot: MonitoringSnapshot): AgentIdentity {
    if (!snapshot.agent) throw new ServiceUnavailableException('Monitoring configuration is unavailable');
    return { organizationId: snapshot.organizationId, vmId: snapshot.id, agentId: snapshot.agent.id };
  }

  private current(snapshot: MonitoringSnapshot): { definition: MonitoringDefinition; secrets: MonitoringSecrets; rendered: RenderedConfig } {
    const context = this.secrets.getRenderContext(snapshot.os as SupportedAgentOs);
    const config = snapshot.monitoringConfig!;
    const definition = validateMonitoringDefinition(config.definition, context.os);
    const secrets = config.secretsCiphertext ? this.secrets.decrypt(config.secretsCiphertext, this.identity(snapshot)) : {};
    const rendered = renderMonitoringConfig(definition, secrets, context);
    constructAgentConfigEnvelope(config.version, rendered);
    return { definition, secrets, rendered };
  }

  private humanView(version: number, definition: MonitoringDefinition, secrets: MonitoringSecrets): MonitoringConfigView {
    return { managed: true, version, definition, secretConfigured: monitoringSecretMetadata(definition, secrets) };
  }
}
