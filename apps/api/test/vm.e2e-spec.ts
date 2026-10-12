import { createHash } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentStatus, EnrollmentTokenStatus, VmStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule, isEnrollmentRateLimitedRoute } from '../src/app.module.js';
import { configureApp } from '../src/main.js';
import { authConfig, type AuthConfig } from '../src/config/auth.config.js';
import { metricsConfig } from '../src/config/metrics.config.js';
import { CognitoService } from '../src/infrastructure/aws/cognito/cognito.service.js';
import { CognitoTokenVerifierService } from '../src/infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CacheService } from '../src/infrastructure/cache/cache.service.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { CognitoAuthGuard } from '../src/modules/auth/guards/cognito-auth.guard.js';
import { AuthorizationService } from '../src/modules/authorization/authorization.service.js';
import { PermissionsGuard } from '../src/modules/authorization/guards/permissions.guard.js';
import { MembershipsRepository } from '../src/modules/memberships/memberships.repository.js';
import { UsersRepository } from '../src/modules/users/users.repository.js';
import { UsersService } from '../src/modules/users/users.service.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3100',
    WEB_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/cloudops_test',
    REDIS_URL: 'redis://localhost:6379',
    ENROLLMENT_TOKEN_CACHE_KEY: 'ab'.repeat(32),
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_testpool',
    COGNITO_CLIENT_ID: 'test-client-id',
    COGNITO_CLIENT_SECRET: 'test-client-secret',
  });
});

type TestRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

type TestUser = {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
};

type TestMembership = {
  id: string;
  userId: string;
  organizationId: string;
  role: TestRole;
};

type TestOrganization = {
  id: string;
  name: string;
  slug: string;
};

type TestVm = {
  id: string;
  organizationId: string;
  hostname: string;
  ipAddress: string | null;
  os: string | null;
  status: VmStatus;
  createdAt: Date;
  updatedAt: Date;
};

type TestTag = {
  id: string;
  organizationId: string;
  key: string;
  value: string;
};

type TestVmTag = {
  organizationId: string;
  vmId: string;
  tagId: string;
};

type TestAgent = {
  id: string;
  organizationId: string;
  vmId: string;
  credentialHash: string;
  status: AgentStatus;
  enrolledAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
};

type TestEnrollmentToken = {
  id: string;
  organizationId: string;
  vmId: string;
  tokenHash: string;
  status: EnrollmentTokenStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
};

type TestState = {
  usersBySub: Map<string, TestUser>;
  usersById: Map<string, TestUser>;
  organizations: Map<string, TestOrganization>;
  memberships: Map<string, TestMembership>;
  vms: Map<string, TestVm>;
  tags: Map<string, TestTag>;
  vmTags: Map<string, TestVmTag>;
  agents: Map<string, TestAgent>;
  tokens: Map<string, TestEnrollmentToken>;
  nextVm: number;
  nextTag: number;
  nextToken: number;
  nextAgent: number;
};

type TestDoubles = {
  state: TestState;
  prisma: ReturnType<typeof createPrismaDouble>;
  cache: InMemoryCacheDouble;
  cognito: ReturnType<typeof createCognitoDoubles>['cognito'];
  verifier: ReturnType<typeof createCognitoDoubles>['verifier'];
  redis: { ping: ReturnType<typeof vi.fn> };
};

type QueryLike = {
  values?: unknown[];
};

type RecordLike = Record<string, unknown>;

export const ORG_A = '00000000-0000-4000-8000-000000000001';
export const ORG_B = '00000000-0000-4000-8000-000000000002';
export const VM_A = '00000000-0000-4000-8000-000000000011';
export const VM_B = '00000000-0000-4000-8000-000000000012';
export const TAG_SHARED = '00000000-0000-4000-8000-000000000031';
export const TAG_B = '00000000-0000-4000-8000-000000000032';
export const AGENT_A = '00000000-0000-4000-8000-000000000041';
export const AGENT_B = '00000000-0000-4000-8000-000000000042';
export const TOKEN_ACTIVE_ID = '00000000-0000-4000-8000-000000000051';
export const TOKEN_REVOKED_ID = '00000000-0000-4000-8000-000000000052';
export const TOKEN_EXPIRED_ID = '00000000-0000-4000-8000-000000000053';
export const TOKEN_CONSUMED_ID = '00000000-0000-4000-8000-000000000054';
export const TOKEN_B_ACTIVE_ID = '00000000-0000-4000-8000-000000000055';

const ADMIN_ID = '00000000-0000-4000-8000-000000000021';
const OPERATOR_ID = '00000000-0000-4000-8000-000000000022';
const VIEWER_ID = '00000000-0000-4000-8000-000000000023';
const ADMIN_ACCESS_TOKEN = 'access-admin';
const OPERATOR_ACCESS_TOKEN = 'access-operator';
const VIEWER_ACCESS_TOKEN = 'access-viewer';
const TEST_CLIENT_ID = 'test-client-id';
const TEST_WEB_URL = 'http://localhost:5173';
const FIXED_NOW = new Date('2026-10-01T12:00:00.000Z');
const TOKEN_ACTIVE = `ENR_${'a'.repeat(43)}`;
const TOKEN_REVOKED = `ENR_${'b'.repeat(43)}`;
const TOKEN_EXPIRED = `ENR_${'c'.repeat(43)}`;
const TOKEN_CONSUMED = `ENR_${'d'.repeat(43)}`;
const TOKEN_B_ACTIVE = `ENR_${'e'.repeat(43)}`;
const OLD_AGENT_CREDENTIAL_HASH = hashSecret(`AGT_${'x'.repeat(43)}`);
const ORG_B_AGENT_CREDENTIAL_HASH = hashSecret(`AGT_${'y'.repeat(43)}`);

const TEST_AUTH_CONFIG: AuthConfig = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_testpool',
  clientId: TEST_CLIENT_ID,
  clientSecret: 'test-client-secret',
};

function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function membershipKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

function vmTagKey(vmId: string, tagId: string): string {
  return `${vmId}:${tagId}`;
}

function tokenForPlaintext(
  id: string,
  organizationId: string,
  vmId: string,
  plaintext: string,
  status: EnrollmentTokenStatus,
  expiresAt: Date,
): TestEnrollmentToken {
  return {
    id,
    organizationId,
    vmId,
    tokenHash: hashSecret(plaintext),
    status,
    expiresAt,
    consumedAt:
      status === EnrollmentTokenStatus.CONSUMED ? new Date(FIXED_NOW) : null,
    revokedAt:
      status === EnrollmentTokenStatus.REVOKED ? new Date(FIXED_NOW) : null,
  };
}

function createTestState(): TestState {
  const users: TestUser[] = [
    {
      id: ADMIN_ID,
      cognitoSub: 'cognito-admin',
      email: 'admin@example.com',
      displayName: 'Admin User',
    },
    {
      id: OPERATOR_ID,
      cognitoSub: 'cognito-operator',
      email: 'operator@example.com',
      displayName: 'Operator User',
    },
    {
      id: VIEWER_ID,
      cognitoSub: 'cognito-viewer',
      email: 'viewer@example.com',
      displayName: 'Viewer User',
    },
  ];
  const organizations: TestOrganization[] = [
    { id: ORG_A, name: 'Organization A', slug: 'organization-a' },
    { id: ORG_B, name: 'Organization B', slug: 'organization-b' },
  ];
  const memberships: TestMembership[] = [
    {
      id: '00000000-0000-4000-8000-000000000061',
      userId: ADMIN_ID,
      organizationId: ORG_A,
      role: 'ADMIN',
    },
    {
      id: '00000000-0000-4000-8000-000000000062',
      userId: OPERATOR_ID,
      organizationId: ORG_A,
      role: 'OPERATOR',
    },
    {
      id: '00000000-0000-4000-8000-000000000063',
      userId: VIEWER_ID,
      organizationId: ORG_A,
      role: 'VIEWER',
    },
  ];
  const createdAt = new Date('2026-09-30T12:00:00.000Z');
  const vms: TestVm[] = [
    {
      id: VM_A,
      organizationId: ORG_A,
      hostname: 'vm-a',
      ipAddress: '10.0.0.11',
      os: null,
      status: VmStatus.HEALTHY,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: VM_B,
      organizationId: ORG_B,
      hostname: 'vm-b',
      ipAddress: '10.0.0.12',
      os: 'Ubuntu 22.04',
      status: VmStatus.WARNING,
      createdAt,
      updatedAt: createdAt,
    },
  ];
  const tags: TestTag[] = [
    {
      id: TAG_SHARED,
      organizationId: ORG_A,
      key: 'environment',
      value: 'shared',
    },
    {
      id: TAG_B,
      organizationId: ORG_B,
      key: 'environment',
      value: 'shared',
    },
  ];
  const vmTags: TestVmTag[] = [
    { organizationId: ORG_A, vmId: VM_A, tagId: TAG_SHARED },
    { organizationId: ORG_B, vmId: VM_B, tagId: TAG_B },
  ];
  const agents: TestAgent[] = [
    {
      id: AGENT_A,
      organizationId: ORG_A,
      vmId: VM_A,
      credentialHash: OLD_AGENT_CREDENTIAL_HASH,
      status: AgentStatus.ACTIVE,
      enrolledAt: new Date('2026-09-30T12:00:00.000Z'),
      lastSeenAt: null,
      revokedAt: null,
    },
    {
      id: AGENT_B,
      organizationId: ORG_B,
      vmId: VM_B,
      credentialHash: ORG_B_AGENT_CREDENTIAL_HASH,
      status: AgentStatus.ACTIVE,
      enrolledAt: new Date('2026-09-30T12:00:00.000Z'),
      lastSeenAt: null,
      revokedAt: null,
    },
  ];
  const tokens: TestEnrollmentToken[] = [
    tokenForPlaintext(
      TOKEN_ACTIVE_ID,
      ORG_A,
      VM_A,
      TOKEN_ACTIVE,
      EnrollmentTokenStatus.ACTIVE,
      new Date('2030-01-01T00:00:00.000Z'),
    ),
    tokenForPlaintext(
      TOKEN_REVOKED_ID,
      ORG_A,
      VM_A,
      TOKEN_REVOKED,
      EnrollmentTokenStatus.REVOKED,
      new Date('2030-01-01T00:00:00.000Z'),
    ),
    tokenForPlaintext(
      TOKEN_EXPIRED_ID,
      ORG_A,
      VM_A,
      TOKEN_EXPIRED,
      EnrollmentTokenStatus.ACTIVE,
      new Date('2020-01-01T00:00:00.000Z'),
    ),
    tokenForPlaintext(
      TOKEN_CONSUMED_ID,
      ORG_B,
      VM_B,
      TOKEN_CONSUMED,
      EnrollmentTokenStatus.CONSUMED,
      new Date('2030-01-01T00:00:00.000Z'),
    ),
    tokenForPlaintext(
      TOKEN_B_ACTIVE_ID,
      ORG_B,
      VM_B,
      TOKEN_B_ACTIVE,
      EnrollmentTokenStatus.ACTIVE,
      new Date('2030-01-01T00:00:00.000Z'),
    ),
  ];

  return {
    usersBySub: new Map(users.map((user) => [user.cognitoSub, user])),
    usersById: new Map(users.map((user) => [user.id, user])),
    organizations: new Map(
      organizations.map((organization) => [organization.id, organization]),
    ),
    memberships: new Map(
      memberships.map((membership) => [
        membershipKey(membership.userId, membership.organizationId),
        membership,
      ]),
    ),
    vms: new Map(vms.map((vm) => [vm.id, vm])),
    tags: new Map(tags.map((tag) => [tag.id, tag])),
    vmTags: new Map(
      vmTags.map((association) => [
        vmTagKey(association.vmId, association.tagId),
        association,
      ]),
    ),
    agents: new Map(agents.map((entry) => [entry.id, entry])),
    tokens: new Map(tokens.map((token) => [token.id, token])),
    nextVm: 70,
    nextTag: 80,
    nextToken: 90,
    nextAgent: 100,
  };
}

function asRecord(value: unknown): RecordLike {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected object argument in Prisma double');
  }
  return value as RecordLike;
}

function errorWithCode(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function projectTag(tag: TestTag): { id: string; key: string; value: string } {
  return { id: tag.id, key: tag.key, value: tag.value };
}

function projectVm(state: TestState, vm: TestVm, organizationId: string) {
  const agent = [...state.agents.values()].find(
    (candidate) =>
      candidate.vmId === vm.id && candidate.organizationId === organizationId,
  );
  const vmTags = [...state.vmTags.values()]
    .filter(
      (association) =>
        association.vmId === vm.id &&
        association.organizationId === organizationId,
    )
    .flatMap((association) => {
      const tag = state.tags.get(association.tagId);
      return tag && tag.organizationId === organizationId
        ? [{ organizationId, tag: projectTag(tag) }]
        : [];
    });

  return {
    id: vm.id,
    organizationId: vm.organizationId,
    hostname: vm.hostname,
    ipAddress: vm.ipAddress,
    os: vm.os,
    status: vm.status,
    createdAt: vm.createdAt,
    updatedAt: vm.updatedAt,
    vmTags,
    agent: agent
      ? {
          id: agent.id,
          organizationId: agent.organizationId,
          status: agent.status,
          enrolledAt: agent.enrolledAt,
          lastSeenAt: agent.lastSeenAt,
        }
      : null,
  };
}

function matchesVmWhere(
  state: TestState,
  vm: TestVm,
  where: RecordLike,
): boolean {
  if (
    where.organizationId !== undefined &&
    where.organizationId !== vm.organizationId
  ) {
    return false;
  }
  const conditions = Array.isArray(where.AND) ? where.AND : [];
  return conditions.every((condition) => {
    const vmTags = asRecord(asRecord(condition).vmTags);
    const nested = asRecord(vmTags.some);
    const organizationId = nested.organizationId;
    const tag = asRecord(nested.tag);
    const tagKey = tag.key;
    const tagValue = tag.value;
    return [...state.vmTags.values()].some((association) => {
      const candidateTag = state.tags.get(association.tagId);
      return (
        association.vmId === vm.id &&
        association.organizationId === organizationId &&
        candidateTag?.organizationId === tag.organizationId &&
        candidateTag?.key === tagKey &&
        candidateTag?.value === tagValue
      );
    });
  });
}

function queryValues(value: unknown): unknown[] {
  const query = value as QueryLike;
  return Array.isArray(query.values) ? query.values : [];
}

function createPrismaDouble(state: TestState) {
  const findUser = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as { cognitoSub?: string };
    return where.cognitoSub
      ? (state.usersBySub.get(where.cognitoSub) ?? null)
      : null;
  });
  const findMembership = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where);
    const compound = asRecord(where.userId_organizationId) as {
      userId: string;
      organizationId: string;
    };
    const membership = state.memberships.get(
      membershipKey(compound.userId, compound.organizationId),
    );
    return membership ? { ...membership } : null;
  });

  const findManyVm = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where);
    const skip = typeof args.skip === 'number' ? args.skip : 0;
    const take = typeof args.take === 'number' ? args.take : 50;
    return [...state.vms.values()]
      .filter((vm) => matchesVmWhere(state, vm, where))
      .sort(
        (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
      )
      .slice(skip, skip + take)
      .map((vm) => projectVm(state, vm, String(where.organizationId)));
  });
  const countVm = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where);
    return [...state.vms.values()].filter((vm) =>
      matchesVmWhere(state, vm, where),
    ).length;
  });
  const findUniqueVm = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as {
      id?: string;
      organizationId?: string;
    };
    if (!where.id) {
      return null;
    }
    const vm = state.vms.get(where.id);
    if (
      !vm ||
      (where.organizationId && vm.organizationId !== where.organizationId)
    ) {
      return null;
    }
    return projectVm(state, vm, where.organizationId ?? vm.organizationId);
  });
  const createVm = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const data = asRecord(args.data);
    const organization = asRecord(data.organization);
    const connect = asRecord(organization.connect);
    const organizationId = String(connect.id);
    const hostname = String(data.hostname);
    const duplicate = [...state.vms.values()].some(
      (vm) => vm.organizationId === organizationId && vm.hostname === hostname,
    );
    if (duplicate) {
      throw errorWithCode('P2002', 'unique VM hostname');
    }
    const now = new Date(FIXED_NOW);
    const id = `00000000-0000-4000-8000-${String(state.nextVm++).padStart(12, '0')}`;
    const vm: TestVm = {
      id,
      organizationId,
      hostname,
      ipAddress: typeof data.ipAddress === 'string' ? data.ipAddress : null,
      os: null,
      status: VmStatus.DISCONNECTED,
      createdAt: now,
      updatedAt: now,
    };
    state.vms.set(id, vm);
    return projectVm(state, vm, organizationId);
  });
  const updateVm = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where) as {
      id: string;
      organizationId: string;
    };
    const data = asRecord(args.data);
    const vm = state.vms.get(where.id);
    if (!vm || vm.organizationId !== where.organizationId) {
      throw errorWithCode('P2025', 'VM not found');
    }
    if (
      typeof data.hostname === 'string' &&
      [...state.vms.values()].some(
        (candidate) =>
          candidate.id !== vm.id &&
          candidate.organizationId === vm.organizationId &&
          candidate.hostname === data.hostname,
      )
    ) {
      throw errorWithCode('P2002', 'unique VM hostname');
    }
    if (typeof data.hostname === 'string') {
      vm.hostname = data.hostname;
    }
    if (data.ipAddress === null || typeof data.ipAddress === 'string') {
      vm.ipAddress = data.ipAddress as string | null;
    }
    vm.updatedAt = new Date(FIXED_NOW);
    return projectVm(state, vm, where.organizationId);
  });
  const deleteVm = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as {
      id: string;
      organizationId: string;
    };
    const vm = state.vms.get(where.id);
    if (!vm || vm.organizationId !== where.organizationId) {
      throw errorWithCode('P2025', 'VM not found');
    }
    state.vms.delete(vm.id);
    for (const key of state.vmTags.keys()) {
      if (key.startsWith(`${vm.id}:`)) {
        state.vmTags.delete(key);
      }
    }
    for (const [id, token] of state.tokens) {
      if (token.vmId === vm.id) {
        state.tokens.delete(id);
      }
    }
    for (const [id, agent] of state.agents) {
      if (agent.vmId === vm.id) {
        state.agents.delete(id);
      }
    }
  });

  const txVmFindUnique = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as {
      id: string;
      organizationId: string;
    };
    const vm = state.vms.get(where.id);
    return vm && vm.organizationId === where.organizationId
      ? { id: vm.id }
      : null;
  });
  const txVmCreate = vi.fn(async (input: unknown) => {
    const created = await createVm(input);
    return created;
  });
  const txVmUpdate = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where) as { id: string };
    const data = asRecord(args.data);
    const vm = state.vms.get(where.id);
    if (!vm) {
      throw errorWithCode('P2025', 'VM not found');
    }
    if (data.os === null || typeof data.os === 'string') {
      vm.os = data.os as string | null;
    }
    vm.updatedAt = new Date(FIXED_NOW);
    return vm;
  });

  const txTagUpsert = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where);
    const compound = asRecord(where.organizationId_key_value) as {
      organizationId: string;
      key: string;
      value: string;
    };
    const existing = [...state.tags.values()].find(
      (tag) =>
        tag.organizationId === compound.organizationId &&
        tag.key === compound.key &&
        tag.value === compound.value,
    );
    if (existing) {
      return projectTag(existing);
    }
    const data = asRecord(args.create);
    const tag: TestTag = {
      id: `00000000-0000-4000-8000-${String(state.nextTag++).padStart(12, '0')}`,
      organizationId: String(data.organizationId),
      key: String(data.key),
      value: String(data.value),
    };
    state.tags.set(tag.id, tag);
    return projectTag(tag);
  });
  const txVmTagFindFirst = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as {
      organizationId: string;
      vmId: string;
      tagId: string;
    };
    const association = state.vmTags.get(vmTagKey(where.vmId, where.tagId));
    const vm = state.vms.get(where.vmId);
    const tag = state.tags.get(where.tagId);
    return association &&
      association.organizationId === where.organizationId &&
      vm?.organizationId === where.organizationId &&
      tag?.organizationId === where.organizationId
      ? { tag: projectTag(tag) }
      : null;
  });
  const txVmTagCreate = vi.fn(async (input: unknown) => {
    const data = asRecord(asRecord(input).data) as {
      organizationId: string;
      vmId: string;
      tagId: string;
    };
    state.vmTags.set(vmTagKey(data.vmId, data.tagId), data);
    const tag = state.tags.get(data.tagId);
    if (!tag) {
      throw errorWithCode('P2025', 'tag not found');
    }
    return { tag: projectTag(tag) };
  });
  const txVmTagDeleteMany = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as {
      organizationId: string;
      vmId: string;
      tagId: string;
    };
    const key = vmTagKey(where.vmId, where.tagId);
    const association = state.vmTags.get(key);
    const vm = state.vms.get(where.vmId);
    const tag = state.tags.get(where.tagId);
    if (
      association &&
      association.organizationId === where.organizationId &&
      vm?.organizationId === where.organizationId &&
      tag?.organizationId === where.organizationId
    ) {
      state.vmTags.delete(key);
      return { count: 1 };
    }
    return { count: 0 };
  });

  const txEnrollmentUpdateMany = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where) as {
      organizationId: string;
      vmId: string;
      status: EnrollmentTokenStatus;
    };
    const data = asRecord(args.data);
    let count = 0;
    for (const token of state.tokens.values()) {
      if (
        token.organizationId === where.organizationId &&
        token.vmId === where.vmId &&
        token.status === where.status
      ) {
        token.status = data.status as EnrollmentTokenStatus;
        token.revokedAt = (data.revokedAt as Date) ?? null;
        count += 1;
      }
    }
    return { count };
  });
  const txEnrollmentCreate = vi.fn(async (input: unknown) => {
    const data = asRecord(asRecord(input).data);
    const organization = data.organization ? asRecord(data.organization) : null;
    const vm = data.vm ? asRecord(data.vm) : null;
    const organizationConnect = organization
      ? asRecord(organization.connect)
      : null;
    const vmConnect = vm ? asRecord(vm.connect) : null;
    const organizationId =
      typeof data.organizationId === 'string'
        ? data.organizationId
        : String(organizationConnect?.id);
    const vmId =
      typeof data.vmId === 'string' ? data.vmId : String(vmConnect?.id);
    const id = `00000000-0000-4000-8000-${String(state.nextToken++).padStart(12, '0')}`;
    const token: TestEnrollmentToken = {
      id,
      organizationId,
      vmId,
      tokenHash: String(data.tokenHash),
      status: data.status as EnrollmentTokenStatus,
      expiresAt: data.expiresAt as Date,
      consumedAt: null,
      revokedAt: null,
    };
    state.tokens.set(id, token);
    return { id: token.id, expiresAt: token.expiresAt };
  });
  const txEnrollmentUpdate = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where) as { id: string };
    const data = asRecord(args.data);
    const token = state.tokens.get(where.id);
    if (!token) {
      throw errorWithCode('P2025', 'token not found');
    }
    token.status = data.status as EnrollmentTokenStatus;
    token.consumedAt = (data.consumedAt as Date) ?? null;
    token.revokedAt = (data.revokedAt as Date) ?? null;
    return token;
  });

  const txAgentFindFirst = vi.fn(async (input: unknown) => {
    const where = asRecord(asRecord(input).where) as {
      organizationId: string;
      vmId: string;
    };
    const agent = [...state.agents.values()].find(
      (candidate) =>
        candidate.organizationId === where.organizationId &&
        candidate.vmId === where.vmId,
    );
    return agent ? { id: agent.id, status: agent.status } : null;
  });
  const txAgentCreate = vi.fn(async (input: unknown) => {
    const data = asRecord(asRecord(input).data);
    const agent: TestAgent = {
      id: `00000000-0000-4000-8000-${String(state.nextAgent++).padStart(12, '0')}`,
      organizationId: String(data.organizationId),
      vmId: String(data.vmId),
      credentialHash: String(data.credentialHash),
      status: data.status as AgentStatus,
      enrolledAt: data.enrolledAt as Date,
      lastSeenAt: null,
      revokedAt: (data.revokedAt as Date) ?? null,
    };
    state.agents.set(agent.id, agent);
    return { id: agent.id };
  });
  const txAgentUpdate = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where) as { id: string };
    const data = asRecord(args.data);
    const agent = state.agents.get(where.id);
    if (!agent) {
      throw errorWithCode('P2025', 'agent not found');
    }
    agent.credentialHash = String(data.credentialHash);
    agent.status = data.status as AgentStatus;
    agent.enrolledAt = data.enrolledAt as Date;
    agent.revokedAt = (data.revokedAt as Date) ?? null;
    return { id: agent.id };
  });
  const txAgentUpdateMany = vi.fn(async (input: unknown) => {
    const args = asRecord(input);
    const where = asRecord(args.where) as {
      id: string;
      organizationId: string;
      vmId: string;
      status: AgentStatus;
    };
    const data = asRecord(args.data);
    let count = 0;
    const agent = state.agents.get(where.id);
    if (
      agent &&
      agent.organizationId === where.organizationId &&
      agent.vmId === where.vmId &&
      agent.status === where.status
    ) {
      agent.status = data.status as AgentStatus;
      agent.revokedAt = (data.revokedAt as Date) ?? null;
      count = 1;
    }
    return { count };
  });

  const transaction = {
    $queryRaw: vi.fn(async (input: unknown) => {
      const values = queryValues(input);
      if (values.length === 1 && typeof values[0] === 'string') {
        const token = [...state.tokens.values()].find(
          (candidate) => candidate.tokenHash === values[0],
        );
        return token
          ? [
              {
                id: token.id,
                organizationId: token.organizationId,
                vmId: token.vmId,
                status: token.status,
                expiresAt: token.expiresAt,
              },
            ]
          : [];
      }
      if (
        values.length >= 2 &&
        typeof values[0] === 'string' &&
        typeof values[1] === 'string'
      ) {
        const vm = state.vms.get(values[0]);
        return vm && vm.organizationId === values[1] ? [{ id: vm.id }] : [];
      }
      return [];
    }),
    vm: { findUnique: txVmFindUnique, create: txVmCreate, update: txVmUpdate },
    tag: { upsert: txTagUpsert },
    vmTag: {
      findFirst: txVmTagFindFirst,
      create: txVmTagCreate,
      deleteMany: txVmTagDeleteMany,
    },
    enrollmentToken: {
      findFirst: vi.fn(async (input: unknown) => {
        const args = asRecord(input);
        const where = args.where as {
          organizationId: string;
          vmId: string;
          status: EnrollmentTokenStatus;
          expiresAt: { gt: Date };
        };
        const token = [...state.tokens.values()].find(
          (candidate) =>
            candidate.organizationId === where.organizationId &&
            candidate.vmId === where.vmId &&
            candidate.status === where.status &&
            candidate.expiresAt > where.expiresAt.gt,
        );
        return token
          ? {
              id: token.id,
              tokenHash: token.tokenHash,
              expiresAt: token.expiresAt,
            }
          : null;
      }),
      updateMany: txEnrollmentUpdateMany,
      create: txEnrollmentCreate,
      update: txEnrollmentUpdate,
    },
    agent: {
      findFirst: txAgentFindFirst,
      create: txAgentCreate,
      update: txAgentUpdate,
      updateMany: txAgentUpdateMany,
    },
  };

  let transactionTail = Promise.resolve();
  const runTransaction = vi.fn(async (input: unknown) => {
    const callback = input as (transaction: RecordLike) => unknown;
    const previous = transactionTail;
    let release: (() => void) | undefined;
    transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback(transaction);
    } finally {
      release?.();
    }
  });

  return {
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
    $transaction: runTransaction,
    user: { findUnique: findUser },
    membership: { findUnique: findMembership },
    vm: {
      findMany: findManyVm,
      count: countVm,
      findUnique: findUniqueVm,
      create: createVm,
      update: updateVm,
      delete: deleteVm,
    },
  };
}

class InMemoryCacheDouble {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return this.values.has(key) ? (this.values.get(key) as T) : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async setUntil<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) {
        this.values.delete(key);
      }
    }
  }
}

function createCognitoDoubles(state: TestState) {
  const tokenUsers = new Map<string, TestUser>([
    [ADMIN_ACCESS_TOKEN, state.usersBySub.get('cognito-admin')!],
    [OPERATOR_ACCESS_TOKEN, state.usersBySub.get('cognito-operator')!],
    [VIEWER_ACCESS_TOKEN, state.usersBySub.get('cognito-viewer')!],
  ]);
  const verifyAccessToken = vi.fn(async (token: string) => {
    const user = tokenUsers.get(token);
    if (!user) {
      throw new UnauthorizedException('invalid access token');
    }
    return {
      sub: user.cognitoSub,
      client_id: TEST_CLIENT_ID,
      token_use: 'access' as const,
      scope: 'openid',
    };
  });
  const verifyIdToken = vi.fn();
  return {
    cognito: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      confirmSignUp: vi.fn(),
      resendConfirmationCode: vi.fn(),
      refreshToken: vi.fn(),
      revokeToken: vi.fn(),
    },
    verifier: { verifyAccessToken, verifyIdToken },
  };
}

function createTestDoubles(state: TestState): TestDoubles {
  const cognitoDoubles = createCognitoDoubles(state);
  return {
    state,
    prisma: createPrismaDouble(state),
    cache: new InMemoryCacheDouble(),
    ...cognitoDoubles,
    redis: { ping: vi.fn().mockResolvedValue(true) },
  };
}

function authCookie(accessToken: string): string {
  return `access_token=${accessToken}`;
}

function expectError(
  response: { body: RecordLike },
  statusCode: number,
  code: string,
): void {
  expect(response.body).toMatchObject({
    statusCode,
    code,
  });
  expect(response.body.message).toBeTypeOf('string');
}

function expectNoSecrets(value: unknown, secrets: string[] = []): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }
  expect(serialized).not.toMatch(
    /credentialHash|tokenHash|DATABASE_URL|REDIS_URL|clientSecret/i,
  );
}

function expectHashOnly(state: TestState, plaintextSecrets: string[]): void {
  const tokenJson = JSON.stringify([...state.tokens.values()]);
  const agentJson = JSON.stringify([...state.agents.values()]);
  for (const secret of plaintextSecrets) {
    expect(tokenJson).not.toContain(secret);
    expect(agentJson).not.toContain(secret);
  }
  expect([...state.tokens.values()].every((token) => !('token' in token))).toBe(
    true,
  );
  expect(
    [...state.agents.values()].every((agent) => !('credential' in agent)),
  ).toBe(true);
  expect(
    [...state.tokens.values()].every((token) =>
      /^[a-f0-9]{64}$/.test(token.tokenHash),
    ),
  ).toBe(true);
  expect(
    [...state.agents.values()].every((agent) =>
      /^[a-f0-9]{64}$/.test(agent.credentialHash),
    ),
  ).toBe(true);
}

function tokenRecord(
  state: TestState,
  plaintext: string,
): TestEnrollmentToken | undefined {
  return [...state.tokens.values()].find(
    (token) => token.tokenHash === hashSecret(plaintext),
  );
}

describe('VM and enrollment HTTP contracts (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let doubles: TestDoubles;

  beforeEach(async () => {
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });
    const state = createTestState();
    doubles = createTestDoubles(state);
    const permissionsGuard = new PermissionsGuard(
      new Reflector(),
      new UsersService(
        new UsersRepository(doubles.prisma as unknown as PrismaService),
      ),
      new AuthorizationService(
        new MembershipsRepository(doubles.prisma as unknown as PrismaService),
        doubles.cache as unknown as CacheService,
      ),
    );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CognitoService)
      .useValue(doubles.cognito)
      .overrideProvider(CognitoTokenVerifierService)
      .useValue(doubles.verifier)
      .overrideGuard(CognitoAuthGuard)
      .useValue(
        new CognitoAuthGuard(
          doubles.verifier as unknown as CognitoTokenVerifierService,
        ),
      )
      .overrideGuard(PermissionsGuard)
      .useValue(permissionsGuard)
      .overrideProvider(PrismaService)
      .useValue(doubles.prisma)
      .overrideProvider(CacheService)
      .useValue(doubles.cache)
      .overrideProvider(RedisService)
      .useValue(doubles.redis)
      .overrideProvider(authConfig.KEY)
      .useValue(TEST_AUTH_CONFIG)
      .overrideProvider(metricsConfig.KEY)
      .useValue({ query: null })
      .compile();

    app = moduleFixture.createNestApplication();
    await configureApp(app, { webUrl: TEST_WEB_URL, nodeEnv: 'test' });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.useRealTimers();
  });

  function http() {
    if (!app) {
      throw new Error('Test application is not initialized');
    }
    return request(app.getHttpServer());
  }

  function protectedRequest(accessToken: string) {
    const cookie = authCookie(accessToken);
    return {
      get: (path: string) => http().get(path).set('Cookie', cookie),
      post: (path: string) => http().post(path).set('Cookie', cookie),
      patch: (path: string) => http().patch(path).set('Cookie', cookie),
      delete: (path: string) => http().delete(path).set('Cookie', cookie),
    };
  }

  it('reuses the encrypted ENR across concurrent authorized requests without extending expiry', async () => {
    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`)
      .expect(204);
    const path = `/api/v1/organizations/${ORG_A}/vms/${VM_A}/enrollment-token`;
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        protectedRequest(ADMIN_ACCESS_TOKEN).post(path).expect(201),
      ),
    );
    const first = responses[0];
    for (const response of responses) {
      expect(response.body).toEqual(first.body);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(
      [...doubles.state.tokens.values()].filter(
        (token) =>
          token.vmId === VM_A && token.status === EnrollmentTokenStatus.ACTIVE,
      ),
    ).toHaveLength(1);
    const key = `vm-enrollment:v1:${ORG_A}:${VM_A}:${first.body.tokenId}`;
    const encrypted = await doubles.cache.get(key);
    expect(encrypted).toMatchObject({ version: 1 });
    expect(JSON.stringify(encrypted)).not.toContain(first.body.token);
    await protectedRequest(VIEWER_ACCESS_TOKEN).post(path).expect(403);
    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_B}/vms/${VM_A}/enrollment-token`)
      .expect(404);
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 60_000));
    const again = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(path)
      .expect(201);
    expect(again.body).toEqual(first.body);
    expectHashOnly(doubles.state, [first.body.token]);
  });

  it('rotates a DB-invalid or missing cache token and deletes cached ENR after enrollment', async () => {
    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`)
      .expect(204);
    const path = `/api/v1/organizations/${ORG_A}/vms/${VM_A}/enrollment-token`;
    const first = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(path)
      .expect(201);
    const previous = tokenRecord(doubles.state, first.body.token)!;
    previous.status = EnrollmentTokenStatus.REVOKED;
    const second = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(path)
      .expect(201);
    expect(second.body.token).not.toBe(first.body.token);
    await doubles.cache.delete(
      `vm-enrollment:v1:${ORG_A}:${VM_A}:${second.body.tokenId}`,
    );
    const third = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(path)
      .expect(201);
    expect(third.body.token).not.toBe(second.body.token);
    expect(tokenRecord(doubles.state, second.body.token)?.status).toBe(
      EnrollmentTokenStatus.REVOKED,
    );
    const enrolled = await request(app!.getHttpServer())
      .post('/api/v1/agent-enrollment')
      .send({ token: third.body.token })
      .expect(201);
    expect(enrolled.headers['cache-control']).toBe('no-store');
    expect(
      await doubles.cache.get(
        `vm-enrollment:v1:${ORG_A}:${VM_A}:${third.body.tokenId}`,
      ),
    ).toBeNull();
    await protectedRequest(ADMIN_ACCESS_TOKEN).post(path).expect(409);
    expectHashOnly(doubles.state, [third.body.token, enrolled.body.credential]);
  });

  it('lets an admin exercise VM lifecycle, tags, reissue, and safe projections', async () => {
    const list = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms`)
      .query({ tag: 'environment:shared' })
      .expect(200);
    expect(list.body).toMatchObject({ page: 1, pageSize: 50, total: 1 });
    expect(list.body.items[0]).toMatchObject({
      id: VM_A,
      hostname: 'vm-a',
      status: 'DISCONNECTED',
      metricsState: 'disabled',
      metrics: { cpu: null, memory: null, disk: null },
      os: null,
      tags: [{ id: TAG_SHARED, key: 'environment', value: 'shared' }],
      agent: { id: AGENT_A, status: 'ACTIVE' },
    });
    expectNoSecrets(list.body);

    const detail = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      id: VM_A,
      status: 'DISCONNECTED',
      metricsState: 'disabled',
      os: null,
    });
    expectNoSecrets(detail.body);

    const create = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms`)
      .send({ hostname: 'Created-VM', ipAddress: '10.0.0.50' })
      .expect(201);
    const createdToken = create.body.enrollment.token as string;
    const createdVmId = create.body.vm.id as string;
    expect(create.headers['cache-control']).toBe('no-store');
    const reusedCreated = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(
        `/api/v1/organizations/${ORG_A}/vms/${createdVmId}/enrollment-token`,
      )
      .expect(201);
    expect(reusedCreated.body).toEqual(create.body.enrollment);
    expect(createdToken).toMatch(/^ENR_[A-Za-z0-9_-]{43}$/);
    expect(create.body.vm).toMatchObject({
      id: createdVmId,
      hostname: 'created-vm',
      status: 'DISCONNECTED',
      os: null,
    });
    expect(
      JSON.stringify(create.body).match(new RegExp(createdToken, 'g')),
    ).toHaveLength(1);
    expectHashOnly(doubles.state, [
      createdToken,
      TOKEN_ACTIVE,
      TOKEN_REVOKED,
      TOKEN_EXPIRED,
      TOKEN_CONSUMED,
    ]);

    const duplicate = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms`)
      .send({ hostname: 'created-vm' })
      .expect(409);
    expectError(duplicate, 409, 'VM_HOSTNAME_CONFLICT');
    expectNoSecrets(duplicate.body, [createdToken]);

    const update = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .patch(`/api/v1/organizations/${ORG_A}/vms/${createdVmId}`)
      .send({ hostname: 'renamed-vm', ipAddress: null })
      .expect(200);
    expect(update.body).toMatchObject({
      id: createdVmId,
      hostname: 'renamed-vm',
      ipAddress: null,
    });
    expectNoSecrets(update.body, [createdToken]);

    const tag = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${createdVmId}/tags`)
      .send({ key: 'owner', value: 'CloudOps' })
      .expect(201);
    expect(tag.body).toMatchObject({ key: 'owner', value: 'cloudops' });
    const tagId = tag.body.id as string;

    const replacedTag = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .patch(`/api/v1/organizations/${ORG_A}/vms/${createdVmId}/tags/${tagId}`)
      .send({ key: 'owner', value: 'Platform' })
      .expect(200);
    expect(replacedTag.body).toMatchObject({
      id: expect.any(String),
      key: 'owner',
      value: 'platform',
    });
    const replacementTagId = replacedTag.body.id as string;
    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .delete(
        `/api/v1/organizations/${ORG_A}/vms/${createdVmId}/tags/${replacementTagId}`,
      )
      .expect(204);

    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`)
      .expect(204);
    const reissue = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/enrollment-token`)
      .expect(201);
    const reissuedToken = reissue.body.token as string;
    expect(reissuedToken).toMatch(/^ENR_[A-Za-z0-9_-]{43}$/);
    expect(tokenRecord(doubles.state, TOKEN_ACTIVE)?.status).toBe(
      EnrollmentTokenStatus.REVOKED,
    );
    expectHashOnly(doubles.state, [
      reissuedToken,
      TOKEN_ACTIVE,
      TOKEN_REVOKED,
      TOKEN_EXPIRED,
      TOKEN_CONSUMED,
    ]);
    expectNoSecrets(reissue.body, [TOKEN_ACTIVE]);

    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .delete(`/api/v1/organizations/${ORG_A}/vms/${createdVmId}`)
      .expect(204);
    expect(doubles.state.vms.has(createdVmId)).toBe(false);
    expect(
      [...doubles.state.tokens.values()].some(
        (token) => token.vmId === createdVmId,
      ),
    ).toBe(false);
    expect(
      [...doubles.state.agents.values()].some(
        (agent) => agent.vmId === createdVmId,
      ),
    ).toBe(false);
    expect(
      [...doubles.state.vmTags.keys()].some((key) =>
        key.startsWith(`${createdVmId}:`),
      ),
    ).toBe(false);
  });

  it('allows operator management while keeping viewer read-only', async () => {
    await protectedRequest(OPERATOR_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
      .expect(200);
    const operatorUpdate = await protectedRequest(OPERATOR_ACCESS_TOKEN)
      .patch(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
      .send({ hostname: 'operator-vm' })
      .expect(200);
    expect(operatorUpdate.body.hostname).toBe('operator-vm');

    const operatorTag = await protectedRequest(OPERATOR_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/tags`)
      .send({ key: 'team', value: 'Operations' })
      .expect(201);
    expect(operatorTag.body).toMatchObject({
      key: 'team',
      value: 'operations',
    });

    await protectedRequest(OPERATOR_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`)
      .expect(204);
    await protectedRequest(OPERATOR_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/enrollment-token`)
      .expect(201);
    await protectedRequest(OPERATOR_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`)
      .expect(204);
    expect([...doubles.state.agents.values()][0].status).toBe(
      AgentStatus.REVOKED,
    );

    await protectedRequest(VIEWER_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms`)
      .expect(200);
    await protectedRequest(VIEWER_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
      .expect(200);

    const forbiddenBodies = await Promise.all([
      protectedRequest(VIEWER_ACCESS_TOKEN)
        .post(`/api/v1/organizations/${ORG_A}/vms`)
        .send({ hostname: 'viewer-write' }),
      protectedRequest(VIEWER_ACCESS_TOKEN)
        .patch(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
        .send({ hostname: 'viewer-write' }),
      protectedRequest(VIEWER_ACCESS_TOKEN).delete(
        `/api/v1/organizations/${ORG_A}/vms/${VM_A}`,
      ),
      protectedRequest(VIEWER_ACCESS_TOKEN)
        .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/tags`)
        .send({ key: 'forbidden', value: 'tag' }),
      protectedRequest(VIEWER_ACCESS_TOKEN).post(
        `/api/v1/organizations/${ORG_A}/vms/${VM_A}/enrollment-token`,
      ),
      protectedRequest(VIEWER_ACCESS_TOKEN).post(
        `/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`,
      ),
    ]);
    for (const response of forbiddenBodies) {
      expectError(response, 403, 'AUTH_FORBIDDEN');
    }
  });

  it('returns not-found for every cross-tenant VM operation', async () => {
    const vmBBefore = doubles.state.vms.get(VM_B);
    const tagBBefore = doubles.state.tags.get(TAG_B);
    const vmTagBBefore = doubles.state.vmTags.get(vmTagKey(VM_B, TAG_B));
    const agentBBefore = doubles.state.agents.get(AGENT_B);
    const tokenBBefore = doubles.state.tokens.get(TOKEN_B_ACTIVE_ID);
    const tokenIdsBefore = [...doubles.state.tokens.keys()];

    const requests = [
      protectedRequest(ADMIN_ACCESS_TOKEN).get(
        `/api/v1/organizations/${ORG_A}/vms/${VM_B}`,
      ),
      protectedRequest(ADMIN_ACCESS_TOKEN)
        .patch(`/api/v1/organizations/${ORG_A}/vms/${VM_B}`)
        .send({ hostname: 'cross-tenant' }),
      protectedRequest(ADMIN_ACCESS_TOKEN).delete(
        `/api/v1/organizations/${ORG_A}/vms/${VM_B}`,
      ),
      protectedRequest(ADMIN_ACCESS_TOKEN)
        .post(`/api/v1/organizations/${ORG_A}/vms/${VM_B}/tags`)
        .send({ key: 'cross', value: 'tenant' }),
      protectedRequest(ADMIN_ACCESS_TOKEN)
        .patch(`/api/v1/organizations/${ORG_A}/vms/${VM_B}/tags/${TAG_B}`)
        .send({ key: 'cross', value: 'tenant' }),
      protectedRequest(ADMIN_ACCESS_TOKEN).delete(
        `/api/v1/organizations/${ORG_A}/vms/${VM_B}/tags/${TAG_B}`,
      ),
      protectedRequest(ADMIN_ACCESS_TOKEN).post(
        `/api/v1/organizations/${ORG_A}/vms/${VM_B}/enrollment-token`,
      ),
      protectedRequest(ADMIN_ACCESS_TOKEN).post(
        `/api/v1/organizations/${ORG_A}/vms/${VM_B}/agent/revoke`,
      ),
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      expectError(response, 404, 'RESOURCE_NOT_FOUND');
    }
    expect(doubles.state.vms.get(VM_B)).toEqual(vmBBefore);
    expect(doubles.state.tags.get(TAG_B)).toEqual(tagBBefore);
    expect(doubles.state.vmTags.get(vmTagKey(VM_B, TAG_B))).toEqual(
      vmTagBBefore,
    );
    expect(doubles.state.agents.get(AGENT_B)).toEqual(agentBBefore);
    expect(doubles.state.tokens.get(TOKEN_B_ACTIVE_ID)).toEqual(tokenBBefore);
    expect([...doubles.state.tokens.keys()]).toEqual(tokenIdsBefore);
  });

  it('derives public enrollment organization and VM from the token and stores only hashes', async () => {
    const create = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms`)
      .send({ hostname: 'enrollment-no-os' })
      .expect(201);
    const token = create.body.enrollment.token as string;
    const vmId = create.body.vm.id as string;

    const bodyFields = await http()
      .post('/api/v1/agent-enrollment')
      .send({ token, organizationId: ORG_B, vmId: VM_B })
      .expect(400);
    expectError(bodyFields, 400, 'VALIDATION_ERROR');
    expectNoSecrets(bodyFields.body, [token]);
    expect(doubles.state.agents.size).toBe(2);

    const enrollment = await http()
      .post('/api/v1/agent-enrollment')
      .send({ token })
      .expect(201);
    const credential = enrollment.body.credential as string;
    expect(enrollment.body).toMatchObject({
      organizationId: ORG_A,
      vmId,
      status: 'ACTIVE',
    });
    expect(credential).toMatch(/^AGT_[A-Za-z0-9_-]{43}$/);
    expect(
      JSON.stringify(enrollment.body).match(new RegExp(credential, 'g')),
    ).toHaveLength(1);
    expect(tokenRecord(doubles.state, token)?.status).toBe(
      EnrollmentTokenStatus.CONSUMED,
    );
    expect(doubles.state.vms.get(vmId)?.os).toBeNull();
    expectHashOnly(doubles.state, [token, credential]);

    const replay = await http()
      .post('/api/v1/agent-enrollment')
      .send({ token })
      .expect(401);
    expectError(replay, 401, 'ENROLLMENT_TOKEN_INVALID');
    expectNoSecrets(replay.body, [token, credential]);

    const detail = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms/${vmId}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      id: vmId,
      os: null,
      agent: { status: 'ACTIVE' },
    });
    expectNoSecrets(detail.body, [token, credential]);
  });

  it('rotates a revoked agent only after a fresh enrollment token', async () => {
    const oldCredentialHash = doubles.state.agents.get(AGENT_A)?.credentialHash;
    await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/agent/revoke`)
      .expect(204);
    expect(doubles.state.agents.get(AGENT_A)?.status).toBe(AgentStatus.REVOKED);

    const issue = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms/${VM_A}/enrollment-token`)
      .expect(201);
    const token = issue.body.token as string;
    const enrollment = await http()
      .post('/api/v1/agent-enrollment')
      .send({ token, os: 'Ubuntu 24.04' })
      .expect(201);
    const credential = enrollment.body.credential as string;
    expect(enrollment.body).toMatchObject({
      organizationId: ORG_A,
      vmId: VM_A,
      status: 'ACTIVE',
    });
    expect(doubles.state.agents.get(AGENT_A)?.status).toBe(AgentStatus.ACTIVE);
    expect(doubles.state.agents.get(AGENT_A)?.credentialHash).not.toBe(
      oldCredentialHash,
    );
    expect(doubles.state.vms.get(VM_A)?.os).toBe('Ubuntu 24.04');
    expect(tokenRecord(doubles.state, token)?.status).toBe(
      EnrollmentTokenStatus.CONSUMED,
    );
    expectHashOnly(doubles.state, [token, credential]);

    const detail = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      os: 'Ubuntu 24.04',
      agent: { status: 'ACTIVE' },
    });
    expectNoSecrets(detail.body, [token, credential]);
  });

  it('uses safe validation, authentication, conflict, active-agent, and invalid-token envelopes', async () => {
    const missingSession = await http()
      .get(`/api/v1/organizations/${ORG_A}/vms/${VM_A}`)
      .expect(401);
    expectError(missingSession, 401, 'AUTH_UNAUTHORIZED');

    const invalidUuid = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .get(`/api/v1/organizations/${ORG_A}/vms/not-a-uuid`)
      .expect(400);
    expectError(invalidUuid, 400, 'VALIDATION_ERROR');

    const invalidCreate = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms`)
      .send({ hostname: 'bad-hostname', status: 'CRITICAL', os: 'secret-os' })
      .expect(400);
    expectError(invalidCreate, 400, 'VALIDATION_ERROR');
    expectNoSecrets(invalidCreate.body, ['secret-os']);

    const duplicate = await protectedRequest(ADMIN_ACCESS_TOKEN)
      .post(`/api/v1/organizations/${ORG_A}/vms`)
      .send({ hostname: 'vm-a' })
      .expect(409);
    expectError(duplicate, 409, 'VM_HOSTNAME_CONFLICT');

    const activeAgent = await http()
      .post('/api/v1/agent-enrollment')
      .send({ token: TOKEN_ACTIVE })
      .expect(409);
    expectError(activeAgent, 409, 'AGENT_ALREADY_ENROLLED');
    expectNoSecrets(activeAgent.body, [TOKEN_ACTIVE]);

    const invalidTokens = [TOKEN_REVOKED, TOKEN_EXPIRED, TOKEN_CONSUMED];
    for (const token of invalidTokens) {
      const invalid = await http()
        .post('/api/v1/agent-enrollment')
        .send({ token })
        .expect(401);
      expectError(invalid, 401, 'ENROLLMENT_TOKEN_INVALID');
      expectNoSecrets(invalid.body, [token]);
    }

    const malformed = await http()
      .post('/api/v1/agent-enrollment')
      .send({ token: 'not-a-token' })
      .expect(401);
    expectError(malformed, 401, 'ENROLLMENT_TOKEN_INVALID');
    expectNoSecrets(malformed.body, ['not-a-token']);
  });

  it('enforces the enrollment rate-limit route and returns a generic 429 burst envelope', async () => {
    expect(
      isEnrollmentRateLimitedRoute({
        switchToHttp: () => ({
          getRequest: () => ({ path: '/api/v1/agent-enrollment' }),
        }),
      }),
    ).toBe(true);
    expect(
      isEnrollmentRateLimitedRoute({
        switchToHttp: () => ({
          getRequest: () => ({ path: '/api/v1/organizations/x/vms' }),
        }),
      }),
    ).toBe(false);

    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await http()
          .post('/api/v1/agent-enrollment')
          .send({ token: TOKEN_REVOKED }),
      );
    }
    expect(
      responses.slice(0, 10).every((response) => response.status === 401),
    ).toBe(true);
    expect(responses[10]?.status).toBe(429);
    expectError(responses[10]!, 429, 'RATE_LIMITED');
    expectNoSecrets(responses[10]!.body, [TOKEN_REVOKED]);
  });
});
