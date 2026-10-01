import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ApplicationConflictError,
  ApplicationNotFoundError,
  hasPrismaErrorCode,
} from '../../common/errors/application-conflict.error.js';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import {
  OrganizationSummary,
  OrganizationUpdateInput,
  OrganizationWithRole,
  OrganizationsRepository,
} from './organizations.repository.js';

const ORGANIZATION_CACHE_PREFIX = 'cloudops:v1:organization:';
const MEMBERS_CACHE_PREFIX = 'cloudops:v1:members:';
const MEMBERSHIP_CACHE_PREFIX = 'cloudops:v1:membership:';
const ME_CACHE_PREFIX = 'cloudops:v1:me:';
const ORGANIZATION_CACHE_TTL_SECONDS = 60;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly organizationsRepository: OrganizationsRepository,
    @Optional() private readonly cacheService?: CacheService,
  ) {}

  findForUser(userId: string): Promise<OrganizationWithRole[]> {
    return this.organizationsRepository.findForUser(userId);
  }

  async provisionPersonalOrganization(
    userId: string,
    verifiedEmail: string,
  ): Promise<void> {
    await this.organizationsRepository.provisionPersonalOrganization(
      userId,
      verifiedEmail,
    );
    await this.deleteKeys(`${ME_CACHE_PREFIX}${userId}`);
  }

  async getById(organizationId: string): Promise<OrganizationSummary> {
    const cached = await this.readCache<OrganizationSummary>(
      `${ORGANIZATION_CACHE_PREFIX}${organizationId}`,
    );
    const cachedOrganization = normalizeOrganization(cached, organizationId);
    if (cachedOrganization) {
      return cachedOrganization;
    }

    const organization =
      await this.organizationsRepository.getById(organizationId);
    if (!organization) {
      throw new ApplicationNotFoundError(
        'ORGANIZATION_NOT_FOUND',
        'Organization not found',
      );
    }

    await this.writeCache(
      `${ORGANIZATION_CACHE_PREFIX}${organizationId}`,
      organization,
    );
    return organization;
  }

  async update(
    organizationId: string,
    input: OrganizationUpdateInput,
  ): Promise<OrganizationSummary> {
    try {
      const organization = await this.organizationsRepository.update(
        organizationId,
        input,
      );
      await this.invalidateOrganizationCaches(organizationId);
      return organization;
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new ApplicationConflictError(
          'ORGANIZATION_SLUG_CONFLICT',
          'Organization slug is already in use',
        );
      }
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw new ApplicationNotFoundError(
          'ORGANIZATION_NOT_FOUND',
          'Organization not found',
        );
      }
      throw error;
    }
  }

  private async readCache<T>(key: string): Promise<T | null> {
    if (!this.cacheService) {
      return null;
    }

    try {
      return await this.cacheService.get<T>(key);
    } catch {
      this.warnCacheFailure();
      return null;
    }
  }

  private async writeCache<T>(key: string, value: T): Promise<void> {
    if (!this.cacheService) {
      return;
    }

    try {
      await this.cacheService.set(key, value, ORGANIZATION_CACHE_TTL_SECONDS);
    } catch {
      this.warnCacheFailure();
    }
  }

  private async invalidateOrganizationCaches(
    organizationId: string,
  ): Promise<void> {
    await this.deleteKeys(
      `${ORGANIZATION_CACHE_PREFIX}${organizationId}`,
      `${MEMBERS_CACHE_PREFIX}${organizationId}`,
    );
    await this.deletePrefixes(MEMBERSHIP_CACHE_PREFIX, ME_CACHE_PREFIX);
  }

  private async deleteKeys(...keys: string[]): Promise<void> {
    if (!this.cacheService) {
      return;
    }

    try {
      await this.cacheService.delete(...keys);
    } catch {
      this.warnCacheFailure();
    }
  }

  private async deletePrefixes(...prefixes: string[]): Promise<void> {
    if (!this.cacheService) {
      return;
    }

    for (const prefix of prefixes) {
      try {
        await this.cacheService.deleteByPrefix(prefix);
      } catch {
        this.warnCacheFailure();
      }
    }
  }

  private warnCacheFailure(): void {
    this.logger.warn(
      'Cache operation failed; PostgreSQL remains authoritative',
    );
  }
}

function normalizeOrganization(
  value: unknown,
  organizationId: string,
): OrganizationSummary | null {
  if (
    !isRecord(value) ||
    value.id !== organizationId ||
    typeof value.name !== 'string' ||
    typeof value.slug !== 'string'
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type {
  OrganizationSummary,
  OrganizationUpdateInput,
  OrganizationWithRole,
} from './organizations.repository.js';
