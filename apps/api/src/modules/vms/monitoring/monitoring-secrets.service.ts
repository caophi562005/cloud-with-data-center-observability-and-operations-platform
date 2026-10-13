import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../../config/app.config.js';
import { MAX_MONITORING_CONFIG_BYTES, trustedMonitoringUrlSchema } from './integration-catalog.js';
import { validateMonitoringSecrets } from './monitoring.schema.js';
import type { AgentIdentity, MonitoringRenderContext, MonitoringSecrets, SupportedAgentOs } from './monitoring.types.js';

const unavailable = () => new ServiceUnavailableException('Monitoring configuration is unavailable');

export function requireMonitoringSecretKey(value: unknown = process.env.AGENT_MONITORING_SECRET_KEY): Buffer {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw unavailable();
  return Buffer.from(value, 'hex');
}

// Agent rotation on the same VM must not invalidate its saved service credentials.
// A canonical tuple (not string concatenation) binds ciphertext to org + VM.
function identityAad(identity: AgentIdentity): Buffer {
  if (!identity || ![identity.organizationId, identity.vmId, identity.agentId].every((id) =>
    typeof id === 'string' && Boolean(id.trim()) && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id),
  )) throw unavailable();
  return Buffer.from(JSON.stringify(['opsgrid-monitoring-secrets', 1, identity.organizationId, identity.vmId]), 'utf8');
}

function canonicalSecrets(value: MonitoringSecrets): string {
  const validated = validateMonitoringSecrets(value);
  return JSON.stringify(Object.fromEntries(Object.keys(validated).sort().map((id) =>
    [id, Object.fromEntries(Object.keys(validated[id]).sort().map((field) => [field, validated[id][field]]))],
  )));
}

@Injectable()
export class MonitoringSecretsService {
  constructor(private readonly config: ConfigService) {}

  assertConfigured(): void {
    const key = this.key();
    key.fill(0);
    const settings = this.config.get<AppConfig['agentMonitoring']>('app.agentMonitoring');
    if (!settings || !trustedMonitoringUrlSchema.safeParse(settings.apiPublicUrl).success ||
      !trustedMonitoringUrlSchema.safeParse(settings.metricsWriteUrl).success ||
      new URL(settings.apiPublicUrl!).pathname !== '/') throw unavailable();
  }

  getRenderContext(os: SupportedAgentOs): MonitoringRenderContext {
    this.assertConfigured();
    const settings = this.config.getOrThrow<AppConfig['agentMonitoring']>('app.agentMonitoring');
    if (!settings.apiPublicUrl || !settings.metricsWriteUrl || (os !== 'linux' && os !== 'windows')) throw unavailable();
    return { os, apiOrigin: settings.apiPublicUrl, metricsWriteUrl: settings.metricsWriteUrl };
  }

  encrypt(value: Record<string, Record<string, string>>, identity: AgentIdentity): string {
    const key = this.key();
    try {
      this.assertConfigured();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(identityAad(identity));
      const plaintext = Buffer.from(canonicalSecrets(value), 'utf8');
      try {
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw unavailable();
    } finally {
      key.fill(0);
    }
  }

  decrypt(ciphertext: string, identity: AgentIdentity): Record<string, Record<string, string>> {
    const key = this.key();
    try {
      this.assertConfigured();
      if (typeof ciphertext !== 'string' || ciphertext.length > 2 * MAX_MONITORING_CONFIG_BYTES) throw unavailable();
      const parts = ciphertext.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw unavailable();
      const [nonce, tag, data] = parts.slice(1).map((part) => {
        const decoded = Buffer.from(part, 'base64url');
        if (decoded.toString('base64url') !== part) throw unavailable();
        return decoded;
      });
      if (nonce.length !== 12 || tag.length !== 16 || data.length > MAX_MONITORING_CONFIG_BYTES) throw unavailable();
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(identityAad(identity));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
      try {
        return validateMonitoringSecrets(JSON.parse(plaintext.toString('utf8')));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      // Never bubble OpenSSL, JSON, schema, ciphertext, credential or DSN errors.
      throw unavailable();
    } finally {
      key.fill(0);
    }
  }

  private key(): Buffer {
    return requireMonitoringSecretKey(this.config.get('app.agentMonitoring.secretKey') ?? null);
  }
}
