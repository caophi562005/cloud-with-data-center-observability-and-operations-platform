import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import type { EnrollmentTokenPublic } from './vms.types.js';

const envelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string().regex(/^[a-f0-9]{24}$/),
  tag: z.string().regex(/^[a-f0-9]{32}$/),
  ciphertext: z.string().min(1).max(2048),
});
const tokenSchema = z.object({
  tokenId: z.string().min(1),
  token: z.string().regex(/^ENR_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});

/** Recoverable ENR only. Database status/hash remain authoritative on every read. */
@Injectable()
export class EnrollmentTokenCacheService {
  private readonly key: Buffer | undefined;
  private readonly logger = new Logger(EnrollmentTokenCacheService.name);

  constructor(
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    const key = config.get<string>('ENROLLMENT_TOKEN_CACHE_KEY');
    this.key =
      key && /^[a-fA-F0-9]{64}$/.test(key)
        ? Buffer.from(key, 'hex')
        : undefined;
    if (!this.key) {
      this.logger.warn(
        'Enrollment token reuse disabled: encryption key not configured',
      );
    }
  }

  async get(
    organizationId: string,
    vmId: string,
    tokenId: string,
    now = new Date(),
  ): Promise<EnrollmentTokenPublic | null> {
    if (!this.key) return null;
    const startedAt = Date.now();
    const cacheKey = this.cacheKey(organizationId, vmId, tokenId);
    try {
      const envelope = envelopeSchema.parse(
        await this.bounded(() => this.cache.get<unknown>(cacheKey)),
      );
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(envelope.iv, 'hex'),
      );
      decipher.setAAD(Buffer.from(cacheKey));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const token = tokenSchema.parse(JSON.parse(plaintext));
      const expiresAt = new Date(token.expiresAt);
      // A Redis reply may arrive after expiry even when the read began in time.
      const checkedAt = now.getTime() + Math.max(0, Date.now() - startedAt);
      if (token.tokenId !== tokenId || expiresAt.getTime() <= checkedAt)
        return null;
      return { ...token, expiresAt };
    } catch {
      return null;
    }
  }

  async set(
    organizationId: string,
    vmId: string,
    token: EnrollmentTokenPublic,
    now = new Date(),
  ): Promise<void> {
    if (!this.key || !/^ENR_[A-Za-z0-9_-]{43}$/.test(token.token)) return;
    const ttlSeconds = Math.min(
      86_400,
      Math.floor((token.expiresAt.getTime() - now.getTime()) / 1000),
    );
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    try {
      const cacheKey = this.cacheKey(organizationId, vmId, token.tokenId);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(Buffer.from(cacheKey));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(token), 'utf8'),
        cipher.final(),
      ]).toString('base64');
      await this.bounded(() =>
        this.cache.setUntil(
          cacheKey,
          {
            version: 1,
            iv: iv.toString('hex'),
            tag: cipher.getAuthTag().toString('hex'),
            ciphertext,
          },
          new Date(now.getTime() + ttlSeconds * 1000),
        ),
      );
    } catch {
      // Best effort: loss/outage rotates the token through the locked DB path.
    }
  }

  async invalidate(organizationId: string, vmId: string): Promise<void> {
    try {
      await this.bounded(() =>
        this.cache.deleteByPrefix(this.prefix(organizationId, vmId)),
      );
    } catch {
      // Consumed/revoked rows cannot be reused even if eviction fails.
    }
  }

  private prefix(organizationId: string, vmId: string): string {
    return `vm-enrollment:v1:${organizationId}:${vmId}:`;
  }

  private cacheKey(
    organizationId: string,
    vmId: string,
    tokenId: string,
  ): string {
    return `${this.prefix(organizationId, vmId)}${tokenId}`;
  }

  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Enrollment cache operation timed out')),
            500,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
