import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import { MembershipsRepository } from '../memberships/memberships.repository.js';
import { AuthorizationService } from './authorization.service.js';
import { rolePermissions } from './role-permissions.js';

type CacheMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

type MembershipRepositoryMock = {
  findByUserAndOrganization: ReturnType<typeof vi.fn>;
};

function createCacheMock(): CacheMock {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  };
}

function createMembershipRepositoryMock(): MembershipRepositoryMock {
  return {
    findByUserAndOrganization: vi.fn(),
  };
}

describe('rolePermissions', () => {
  it('defines the approved permission matrix exactly', () => {
    expect(rolePermissions.ADMIN).toEqual(
      expect.arrayContaining([
        'profile.read',
        'organization.read',
        'organization.update',
        'member.read',
        'member.manage',
      ]),
    );
    expect(rolePermissions.ADMIN).toHaveLength(5);
    expect(rolePermissions.OPERATOR).toEqual([
      'profile.read',
      'organization.read',
      'member.read',
    ]);
    expect(rolePermissions.VIEWER).toEqual([
      'profile.read',
      'organization.read',
      'member.read',
    ]);
  });
});

describe('AuthorizationService', () => {
  let cache: CacheMock;
  let repository: MembershipRepositoryMock;
  let service: AuthorizationService;

  beforeEach(() => {
    cache = createCacheMock();
    repository = createMembershipRepositoryMock();
    service = new AuthorizationService(
      repository as unknown as MembershipsRepository,
      cache as unknown as CacheService,
    );
  });

  it('loads a membership from the database on a cache miss and caches the safe context', async () => {
    repository.findByUserAndOrganization.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.ADMIN,
    });

    await expect(service.getMembership('user-1', 'org-1')).resolves.toEqual({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.ADMIN,
      permissions: rolePermissions.ADMIN,
    });
    expect(cache.get).toHaveBeenCalledWith(
      'cloudops:v1:membership:user-1:org-1',
    );
    expect(repository.findByUserAndOrganization).toHaveBeenCalledWith(
      'user-1',
      'org-1',
    );
    expect(cache.set).toHaveBeenCalledWith(
      'cloudops:v1:membership:user-1:org-1',
      expect.objectContaining({ userId: 'user-1', organizationId: 'org-1' }),
      60,
    );
  });

  it('falls back to the database when Redis reads fail', async () => {
    cache.get.mockRejectedValue(new Error('redis unavailable'));
    repository.findByUserAndOrganization.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.VIEWER,
    });

    await expect(
      service.getMembership('user-1', 'org-1'),
    ).resolves.toMatchObject({
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.VIEWER,
      permissions: rolePermissions.VIEWER,
    });
    expect(repository.findByUserAndOrganization).toHaveBeenCalled();
  });

  it('never uses a membership cached for a different organization', async () => {
    cache.get.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.ADMIN,
      permissions: rolePermissions.ADMIN,
    });
    repository.findByUserAndOrganization.mockResolvedValue(null);

    await expect(service.getMembership('user-1', 'org-2')).resolves.toBeNull();
    expect(cache.get).toHaveBeenCalledWith(
      'cloudops:v1:membership:user-1:org-2',
    );
    expect(repository.findByUserAndOrganization).toHaveBeenCalledWith(
      'user-1',
      'org-2',
    );
  });

  it('returns a safe not-found error when a user has no membership', async () => {
    repository.findByUserAndOrganization.mockResolvedValue(null);

    await expect(
      service.requirePermission('user-1', 'org-2', 'organization.read'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns a forbidden error when the membership lacks a permission', async () => {
    repository.findByUserAndOrganization.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.VIEWER,
    });

    await expect(
      service.requirePermission('user-1', 'org-1', 'organization.update'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns membership context for an allowed permission', async () => {
    repository.findByUserAndOrganization.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.OPERATOR,
    });

    await expect(
      service.requirePermission('user-1', 'org-1', 'member.read'),
    ).resolves.toMatchObject({
      userId: 'user-1',
      organizationId: 'org-1',
      role: Role.OPERATOR,
    });
  });
});
