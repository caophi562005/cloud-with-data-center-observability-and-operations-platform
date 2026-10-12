import { AgentStatus, EnrollmentTokenStatus, VmStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import type {
  VmCreateInput,
  VmTagInput,
  VmUpdateInput,
} from './schemas/vm.schema.js';
import { VmsRepository } from './vms.repository.js';
import type { VmRecord } from './vms.types.js';

const ORG_A = '00000000-0000-4000-8000-000000000001';
const VM_A = '00000000-0000-4000-8000-000000000002';
const TAG_ENV_PROD = '00000000-0000-4000-8000-000000000003';
const TAG_ENV_STAGING = '00000000-0000-4000-8000-000000000004';
const TOKEN_EXPIRES_AT = new Date('2026-10-02T00:00:00.000Z');

const vmRecord: VmRecord = {
  id: VM_A,
  organizationId: ORG_A,
  hostname: 'db-prod-01',
  ipAddress: '192.0.2.10',
  os: null,
  status: VmStatus.DISCONNECTED,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  tags: [{ id: 'tag-1', key: 'env', value: 'prod' }],
  agent: {
    id: 'agent-1',
    status: AgentStatus.ACTIVE,
    enrolledAt: new Date('2026-10-01T00:00:00.000Z'),
    lastSeenAt: null,
  },
};

type TransactionMock = {
  vm: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  enrollmentToken: { create: ReturnType<typeof vi.fn> };
  tag: {
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  vmTag: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
};

type PrismaMock = {
  $transaction: ReturnType<typeof vi.fn>;
  vm: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  tag: { update: ReturnType<typeof vi.fn> };
};

function createTransactionMock(): TransactionMock {
  return {
    vm: { create: vi.fn(), findUnique: vi.fn() },
    enrollmentToken: { create: vi.fn() },
    tag: { upsert: vi.fn(), update: vi.fn() },
    vmTag: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
  };
}

function createPrismaMock(): PrismaMock {
  return {
    $transaction: vi.fn(),
    vm: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tag: { update: vi.fn() },
  };
}

describe('VmsRepository', () => {
  let prisma: PrismaMock;
  let repository: VmsRepository;

  beforeEach(() => {
    prisma = createPrismaMock();
    repository = new VmsRepository(prisma as unknown as PrismaService);
  });

  it('creates a disconnected VM and active hashed token in one transaction', async () => {
    const transaction = createTransactionMock();
    transaction.vm.create.mockResolvedValue(vmRecord);
    transaction.enrollmentToken.create.mockResolvedValue({ id: 'token-1' });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await expect(
      repository.createWithEnrollment(
        ORG_A,
        { hostname: 'db-prod-01', ipAddress: '192.0.2.10' },
        { hash: 'hashed-enrollment-token', expiresAt: TOKEN_EXPIRES_AT },
      ),
    ).resolves.toEqual({
      vm: vmRecord,
      tokenId: 'token-1',
      expiresAt: TOKEN_EXPIRES_AT,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.vm.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organization: { connect: { id: ORG_A } },
          hostname: 'db-prod-01',
          ipAddress: '192.0.2.10',
          status: VmStatus.DISCONNECTED,
        }),
      }),
    );
    expect(transaction.enrollmentToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organization: { connect: { id: ORG_A } },
          vm: { connect: { id: VM_A } },
          tokenHash: 'hashed-enrollment-token',
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: TOKEN_EXPIRES_AT,
        }),
      }),
    );
    const tokenData = transaction.enrollmentToken.create.mock.calls[0][0].data;
    expect(tokenData).not.toHaveProperty('token');
  });

  it('lists VMs with organization-scoped filters, count, and tag relation reads', async () => {
    prisma.vm.findMany.mockResolvedValue([vmRecord]);
    prisma.vm.count.mockResolvedValue(1);

    await expect(
      repository.list(ORG_A, {
        page: 2,
        pageSize: 25,
        tags: [{ key: 'env', value: 'prod' }],
      }),
    ).resolves.toEqual({ items: [vmRecord], page: 2, pageSize: 25, total: 1 });

    const findManyArgs = prisma.vm.findMany.mock.calls[0][0];
    expect(findManyArgs.where.organizationId).toBe(ORG_A);
    expect(findManyArgs.where.AND[0].vmTags.some.organizationId).toBe(ORG_A);
    expect(findManyArgs.skip).toBe(25);
    expect(findManyArgs.take).toBe(25);
    expect(findManyArgs.select.vmTags.where.organizationId).toBe(ORG_A);
    expect(prisma.vm.count).toHaveBeenCalledWith({
      where: findManyArgs.where,
    });
  });

  it('uses independent organization-scoped AND conditions for multiple tag filters', async () => {
    prisma.vm.findMany.mockResolvedValue([vmRecord]);
    prisma.vm.count.mockResolvedValue(1);

    await repository.list(ORG_A, {
      page: 1,
      pageSize: 50,
      tags: [
        { key: 'env', value: 'production' },
        { key: 'role', value: 'database' },
      ],
    });

    const where = prisma.vm.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      {
        vmTags: {
          some: {
            organizationId: ORG_A,
            tag: { organizationId: ORG_A, key: 'env', value: 'production' },
          },
        },
      },
      {
        vmTags: {
          some: {
            organizationId: ORG_A,
            tag: { organizationId: ORG_A, key: 'role', value: 'database' },
          },
        },
      },
    ]);
  });

  it('adds a canonical tag and an idempotent VM association in one transaction', async () => {
    const transaction = createTransactionMock();
    const tag = { id: TAG_ENV_PROD, key: 'env', value: 'production' };
    transaction.vm.findUnique.mockResolvedValue({ id: VM_A });
    transaction.tag.upsert.mockResolvedValue(tag);
    transaction.vmTag.findFirst.mockResolvedValue(null);
    transaction.vmTag.create.mockResolvedValue({ tag });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    const input: VmTagInput = { key: 'env', value: 'production' };
    await expect(repository.addTag(ORG_A, VM_A, input)).resolves.toEqual(tag);

    expect(transaction.vm.findUnique).toHaveBeenCalledWith({
      where: { id: VM_A, organizationId: ORG_A },
      select: { id: true },
    });
    expect(transaction.tag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_key_value: {
            organizationId: ORG_A,
            key: 'env',
            value: 'production',
          },
        },
        update: {},
      }),
    );
    expect(transaction.vmTag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { organizationId: ORG_A, vmId: VM_A, tagId: TAG_ENV_PROD },
      }),
    );
  });

  it('returns an existing association without creating a duplicate', async () => {
    const transaction = createTransactionMock();
    const tag = { id: TAG_ENV_PROD, key: 'env', value: 'production' };
    transaction.vm.findUnique.mockResolvedValue({ id: VM_A });
    transaction.tag.upsert.mockResolvedValue(tag);
    transaction.vmTag.findFirst.mockResolvedValue({ tag });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await expect(
      repository.addTag(ORG_A, VM_A, { key: 'env', value: 'production' }),
    ).resolves.toEqual(tag);
    expect(transaction.vmTag.create).not.toHaveBeenCalled();
    expect(transaction.vmTag.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_A,
          vmId: VM_A,
          tagId: TAG_ENV_PROD,
          tag: { organizationId: ORG_A },
          vm: { organizationId: ORG_A },
        },
      }),
    );
  });

  it('reuses one canonical tag definition across VM associations', async () => {
    const transaction = createTransactionMock();
    const tag = { id: TAG_ENV_PROD, key: 'env', value: 'production' };
    transaction.vm.findUnique.mockResolvedValue({ id: VM_A });
    transaction.tag.upsert.mockResolvedValue(tag);
    transaction.vmTag.findFirst.mockResolvedValue(null);
    transaction.vmTag.create.mockResolvedValue({ tag });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await repository.addTag(ORG_A, VM_A, {
      key: 'env',
      value: 'production',
    });
    await repository.addTag(ORG_A, '00000000-0000-4000-8000-000000000005', {
      key: 'env',
      value: 'production',
    });

    expect(transaction.tag.upsert).toHaveBeenCalledTimes(2);
    expect(transaction.tag.upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          organizationId_key_value: {
            organizationId: ORG_A,
            key: 'env',
            value: 'production',
          },
        },
      }),
    );
  });

  it('replaces only the target association and never mutates canonical tags', async () => {
    const transaction = createTransactionMock();
    const oldTag = { id: TAG_ENV_PROD, key: 'env', value: 'production' };
    const replacement = { id: TAG_ENV_STAGING, key: 'env', value: 'staging' };
    transaction.vmTag.findFirst
      .mockResolvedValueOnce({ tag: oldTag })
      .mockResolvedValueOnce(null);
    transaction.tag.upsert.mockResolvedValue(replacement);
    transaction.vmTag.deleteMany.mockResolvedValue({ count: 1 });
    transaction.vmTag.create.mockResolvedValue({ tag: replacement });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await expect(
      repository.updateTag(ORG_A, VM_A, TAG_ENV_PROD, {
        key: 'env',
        value: 'staging',
      }),
    ).resolves.toEqual(replacement);

    expect(transaction.tag.update).not.toHaveBeenCalled();
    expect(
      transaction.vmTag.findFirst.mock.calls.map(([args]) => args.where),
    ).toEqual([
      {
        organizationId: ORG_A,
        vmId: VM_A,
        tagId: TAG_ENV_PROD,
        tag: { organizationId: ORG_A },
        vm: { organizationId: ORG_A },
      },
      {
        organizationId: ORG_A,
        vmId: VM_A,
        tagId: TAG_ENV_STAGING,
        tag: { organizationId: ORG_A },
        vm: { organizationId: ORG_A },
      },
    ]);
    expect(transaction.vmTag.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_A,
        vmId: VM_A,
        tagId: TAG_ENV_PROD,
        tag: { organizationId: ORG_A },
        vm: { organizationId: ORG_A },
      },
    });
    expect(transaction.vmTag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId: ORG_A,
          vmId: VM_A,
          tagId: TAG_ENV_STAGING,
        },
      }),
    );
  });

  it('does not delete the association when updating a tag to the same value', async () => {
    const transaction = createTransactionMock();
    const existingTag = { id: TAG_ENV_PROD, key: 'env', value: 'production' };
    transaction.vmTag.findFirst
      .mockResolvedValueOnce({ tag: existingTag })
      .mockResolvedValueOnce({ tag: existingTag });
    transaction.tag.upsert.mockResolvedValue(existingTag);
    transaction.vmTag.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await expect(
      repository.updateTag(ORG_A, VM_A, TAG_ENV_PROD, {
        key: 'env',
        value: 'production',
      }),
    ).resolves.toEqual(existingTag);

    expect(transaction.vmTag.deleteMany).not.toHaveBeenCalled();
    expect(transaction.vmTag.create).not.toHaveBeenCalled();
  });

  it('removes only the organization-scoped VM association and retains the canonical tag', async () => {
    const transaction = createTransactionMock();
    transaction.vmTag.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await expect(
      repository.removeTag(ORG_A, VM_A, TAG_ENV_PROD),
    ).resolves.toBeUndefined();

    expect(transaction.vmTag.deleteMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_A,
        vmId: VM_A,
        tagId: TAG_ENV_PROD,
        tag: { organizationId: ORG_A },
        vm: { organizationId: ORG_A },
      },
    });
    expect(transaction.tag.update).not.toHaveBeenCalled();
  });

  it('scopes get, update, and remove by both organization and VM id', async () => {
    prisma.vm.findUnique.mockResolvedValue(vmRecord);
    prisma.vm.update.mockResolvedValue({ ...vmRecord, hostname: 'db-prod-02' });
    prisma.vm.delete.mockResolvedValue(vmRecord);

    await expect(repository.getById(ORG_A, VM_A)).resolves.toEqual(vmRecord);
    await expect(
      repository.update(ORG_A, VM_A, { hostname: 'db-prod-02' }),
    ).resolves.toMatchObject({ hostname: 'db-prod-02' });
    await expect(repository.remove(ORG_A, VM_A)).resolves.toBeUndefined();

    expect(prisma.vm.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VM_A, organizationId: ORG_A },
      }),
    );
    expect(prisma.vm.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: VM_A, organizationId: ORG_A },
        data: { hostname: 'db-prod-02' },
      }),
    );
    expect(prisma.vm.delete).toHaveBeenCalledWith({
      where: { id: VM_A, organizationId: ORG_A },
    });
  });

  it('updates only hostname and IP address fields', async () => {
    const input: VmUpdateInput = { ipAddress: null };
    prisma.vm.update.mockResolvedValue({ ...vmRecord, ipAddress: null });

    await repository.update(ORG_A, VM_A, input);

    const updateArgs = prisma.vm.update.mock.calls[0][0];
    expect(updateArgs.data).toEqual({ ipAddress: null });
    expect(updateArgs.data).not.toHaveProperty('os');
    expect(updateArgs.data).not.toHaveProperty('status');
  });

  it('accepts create input without an IP address', async () => {
    const input: VmCreateInput = { hostname: 'db-prod-01' };
    const transaction = createTransactionMock();
    transaction.vm.create.mockResolvedValue(vmRecord);
    transaction.enrollmentToken.create.mockResolvedValue({ id: 'token-1' });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );

    await repository.createWithEnrollment(ORG_A, input, {
      hash: 'hash',
      expiresAt: TOKEN_EXPIRES_AT,
    });

    expect(transaction.vm.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ ipAddress: undefined }),
      }),
    );
  });
});
