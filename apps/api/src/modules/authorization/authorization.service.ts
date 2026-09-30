import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Role } from '@prisma/client';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import {
  MembershipsRepository,
  type MembershipRecord,
} from '../memberships/memberships.repository.js';
import type { Permission } from './permissions.js';
import { rolePermissions } from './role-permissions.js';

export const MEMBERSHIP_CACHE_PREFIX = 'cloudops:v1:membership:';
export const MEMBERSHIP_CACHE_TTL_SECONDS = 60;

export type MembershipContext = MembershipRecord & {
  permissions: readonly Permission[];
};

@Injectable()
export class AuthorizationService {
  constructor(
    private readonly membershipsRepository: MembershipsRepository,
    @Optional() private readonly cacheService?: CacheService,
  ) {}

  async getMembership(
    userId: string,
    organizationId: string,
  ): Promise<MembershipContext | null> {
    const cacheKey = membershipCacheKey(userId, organizationId);
    let cached: unknown = null;

    if (this.cacheService) {
      try {
        cached = await this.cacheService.get<unknown>(cacheKey);
      } catch {
        // Redis is only an optimization. PostgreSQL remains authoritative.
      }
    }

    const cachedContext = normalizeMembership(cached, userId, organizationId);
    if (cachedContext) {
      return cachedContext;
    }

    const membership =
      await this.membershipsRepository.findByUserAndOrganization(
        userId,
        organizationId,
      );
    if (!membership) {
      return null;
    }

    const context = toMembershipContext(membership);
    if (this.cacheService) {
      try {
        await this.cacheService.set(
          cacheKey,
          context,
          MEMBERSHIP_CACHE_TTL_SECONDS,
        );
      } catch {
        // A cache write failure must never change authorization correctness.
      }
    }

    return context;
  }

  async requirePermission(
    userId: string,
    organizationId: string,
    permission: Permission,
  ): Promise<MembershipContext> {
    const membership = await this.getMembership(userId, organizationId);
    if (!membership) {
      throw new NotFoundException({
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    if (!membership.permissions.includes(permission)) {
      throw new ForbiddenException({
        code: 'AUTH_FORBIDDEN',
        message: 'Insufficient permissions',
      });
    }

    return membership;
  }
}

export function membershipCacheKey(
  userId: string,
  organizationId: string,
): string {
  return `${MEMBERSHIP_CACHE_PREFIX}${userId}:${organizationId}`;
}

function toMembershipContext(membership: MembershipRecord): MembershipContext {
  return {
    id: membership.id,
    userId: membership.userId,
    organizationId: membership.organizationId,
    role: membership.role,
    permissions: [...rolePermissions[membership.role]],
  };
}

function normalizeMembership(
  value: unknown,
  userId: string,
  organizationId: string,
): MembershipContext | null {
  if (!isRecord(value)) {
    return null;
  }

  if (
    typeof value.id !== 'string' ||
    value.userId !== userId ||
    value.organizationId !== organizationId ||
    !isRole(value.role)
  ) {
    return null;
  }

  return toMembershipContext({
    id: value.id,
    userId,
    organizationId,
    role: value.role,
  });
}

function isRole(value: unknown): value is Role {
  return value === 'ADMIN' || value === 'OPERATOR' || value === 'VIEWER';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
