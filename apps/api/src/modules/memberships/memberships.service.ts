import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Role } from '@prisma/client';
import {
  ApplicationConflictError,
  ApplicationNotFoundError,
  hasPrismaErrorCode,
} from '../../common/errors/application-conflict.error.js';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import {
  MemberSummary,
  MembershipCreateInput,
  MembershipsRepository,
} from './memberships.repository.js';

const ORGANIZATION_CACHE_PREFIX = 'cloudops:v1:organization:';
const MEMBERS_CACHE_PREFIX = 'cloudops:v1:members:';
const MEMBERSHIP_CACHE_PREFIX = 'cloudops:v1:membership:';
const ME_CACHE_PREFIX = 'cloudops:v1:me:';
const MEMBERS_CACHE_TTL_SECONDS = 60;

@Injectable()
export class MembershipsService {
  private readonly logger = new Logger(MembershipsService.name);

  constructor(
    private readonly membershipsRepository: MembershipsRepository,
    @Optional() private readonly cacheService?: CacheService,
  ) {}

  async list(organizationId: string): Promise<MemberSummary[]> {
    const cacheKey = `${MEMBERS_CACHE_PREFIX}${organizationId}`;
    const cached = await this.readCache<unknown>(cacheKey);
    const cachedMembers = normalizeMembers(cached);
    if (cachedMembers) {
      return cachedMembers;
    }

    const members = await this.membershipsRepository.list(organizationId);
    await this.writeCache(cacheKey, members);
    return members;
  }

  async create(
    organizationId: string,
    input: MembershipCreateInput,
  ): Promise<MemberSummary> {
    try {
      const member = await this.membershipsRepository.create(
        organizationId,
        input,
      );
      await this.invalidateMembershipCaches(organizationId, input.userId);
      return member;
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new ApplicationConflictError(
          'MEMBERSHIP_ALREADY_EXISTS',
          'User is already a member of this organization',
        );
      }
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw new ApplicationNotFoundError(
          'MEMBERSHIP_NOT_FOUND',
          'Organization or user not found',
        );
      }
      throw error;
    }
  }

  async updateRole(
    organizationId: string,
    userId: string,
    role: Role,
  ): Promise<MemberSummary> {
    try {
      const member = await this.membershipsRepository.updateRole(
        organizationId,
        userId,
        role,
      );
      await this.invalidateMembershipCaches(organizationId, userId);
      return member;
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw new ApplicationNotFoundError(
          'MEMBERSHIP_NOT_FOUND',
          'Membership not found',
        );
      }
      throw error;
    }
  }

  async remove(organizationId: string, userId: string): Promise<void> {
    try {
      await this.membershipsRepository.remove(organizationId, userId);
      await this.invalidateMembershipCaches(organizationId, userId);
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw new ApplicationNotFoundError(
          'MEMBERSHIP_NOT_FOUND',
          'Membership not found',
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
      await this.cacheService.set(key, value, MEMBERS_CACHE_TTL_SECONDS);
    } catch {
      this.warnCacheFailure();
    }
  }

  private async invalidateMembershipCaches(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.deleteKeys(
      `${ORGANIZATION_CACHE_PREFIX}${organizationId}`,
      `${MEMBERS_CACHE_PREFIX}${organizationId}`,
      `${MEMBERSHIP_CACHE_PREFIX}${userId}:${organizationId}`,
      `${ME_CACHE_PREFIX}${userId}`,
    );
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

  private warnCacheFailure(): void {
    this.logger.warn(
      'Cache operation failed; PostgreSQL remains authoritative',
    );
  }
}

function normalizeMembers(value: unknown): MemberSummary[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const members: MemberSummary[] = [];
  for (const member of value) {
    if (!isRecord(member) || !isRole(member.role)) {
      return null;
    }

    if (
      typeof member.id !== 'string' ||
      typeof member.userId !== 'string' ||
      typeof member.email !== 'string' ||
      (member.displayName !== null && typeof member.displayName !== 'string')
    ) {
      return null;
    }

    members.push({
      id: member.id,
      userId: member.userId,
      email: member.email,
      displayName: member.displayName,
      role: member.role,
    });
  }

  return members;
}

function isRole(value: unknown): value is Role {
  return value === 'ADMIN' || value === 'OPERATOR' || value === 'VIEWER';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type {
  MemberSummary,
  MembershipCreateInput,
} from './memberships.repository.js';
