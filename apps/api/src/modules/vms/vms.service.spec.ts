import { Prisma, VmStatus } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationConflictError,
  ApplicationNotFoundError,
} from '../../common/errors/application-conflict.error.js';
import { SecretService } from './secret.service.js';
import type {
  VmCreateInput,
  VmTagInput,
  VmUpdateInput,
} from './schemas/vm.schema.js';
import { VmsRepository } from './vms.repository.js';
import type { VmRecord } from './vms.types.js';
import { VmsService } from './vms.service.js';
import { VmMetricsService } from './vm-metrics.service.js';

const ORG_A = '00000000-0000-4000-8000-000000000001';
const VM_A = '00000000-0000-4000-8000-000000000002';
const PLAINTEXT_TOKEN = `ENR_${'a'.repeat(43)}`;

const vmRecord: VmRecord = {
  id: VM_A,
  organizationId: ORG_A,
  hostname: 'db-prod-01',
  ipAddress: null,
  os: 'Linux',
  status: VmStatus.DISCONNECTED,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  tags: [],
  agent: null,
};

type RepositoryMock = {
  createWithEnrollment: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  addTag: ReturnType<typeof vi.fn>;
  updateTag: ReturnType<typeof vi.fn>;
  removeTag: ReturnType<typeof vi.fn>;
};

function createRepositoryMock(): RepositoryMock {
  return {
    createWithEnrollment: vi.fn(),
    list: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    addTag: vi.fn(),
    updateTag: vi.fn(),
    removeTag: vi.fn(),
  };
}

describe('VmsService', () => {
  it.each(['Linux', 'Windows Server 2022', null])('appends capabilities to list/get without optional telemetry for %s', async (os) => {
    const repository = createRepositoryMock();
    const record = { ...vmRecord, os };
    repository.list.mockResolvedValue({ items: [record], page: 1, pageSize: 25, total: 1 });
    repository.getById.mockResolvedValue(record);
    const service = new VmsService(repository as unknown as VmsRepository, {} as SecretService);
    const platform = os === null ? 'unknown' : os === 'Linux' ? 'linux' : 'windows';
    const current = await service.get(ORG_A, VM_A);
    const page = await service.list(ORG_A, { page: 1, pageSize: 25, tags: [] });
    expect(current).toHaveProperty('metricsCapabilities.platform', platform);
    expect(page.items[0]).toHaveProperty('metricsCapabilities.platform', platform);
    expect(current).not.toHaveProperty('metrics');
    expect(current).toMatchObject(record);
  });
  it('enriches only authorized list/detail reads while retaining pagination and tags', async () => {
    const repository = createRepositoryMock();
    const page = { items: [vmRecord], page: 2, pageSize: 25, total: 30 };
    repository.list.mockResolvedValue(page);
    repository.getById.mockResolvedValue(vmRecord);
    const enriched = {
      ...vmRecord,
      metrics: { cpu: 0 },
      lastSeenAt: null,
      metricsState: 'available',
    };
    const telemetry = { enrichPage: vi.fn().mockResolvedValue([enriched]) };
    const service = new VmsService(
      repository as unknown as VmsRepository,
      {} as SecretService,
      undefined,
      undefined,
      telemetry as unknown as VmMetricsService,
    );
    expect(
      await service.list(ORG_A, { page: 2, pageSize: 25, tags: [] }),
    ).toEqual({ ...page, items: [enriched] });
    expect(await service.get(ORG_A, VM_A)).toEqual(enriched);
    expect(telemetry.enrichPage).toHaveBeenCalledTimes(2);
    repository.getById.mockResolvedValue(null);
    await expect(service.get(ORG_A, VM_A)).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
    expect(telemetry.enrichPage).toHaveBeenCalledTimes(2);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates atomically and exposes plaintext enrollment token only in the create result', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const repository = createRepositoryMock();
    const secretService = {
      generate: vi.fn().mockReturnValue({
        value: PLAINTEXT_TOKEN,
        hash: 'hashed-enrollment-token',
      }),
    };
    repository.createWithEnrollment.mockResolvedValue({
      vm: vmRecord,
      tokenId: 'token-1',
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    const service = new VmsService(
      repository as unknown as VmsRepository,
      secretService as unknown as SecretService,
    );

    const result = await service.create(ORG_A, { hostname: 'db-prod-01' });

    expect(result.vm.status).toBe(VmStatus.DISCONNECTED);
    expect(result.enrollment).toEqual({
      tokenId: 'token-1',
      token: PLAINTEXT_TOKEN,
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(JSON.stringify(result.vm)).not.toContain(PLAINTEXT_TOKEN);
    expect(secretService.generate).toHaveBeenCalledOnce();
    expect(secretService.generate).toHaveBeenCalledWith('ENR_');
    expect(repository.createWithEnrollment).toHaveBeenCalledWith(
      ORG_A,
      { hostname: 'db-prod-01' },
      {
        hash: 'hashed-enrollment-token',
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
      },
    );
    expect(repository.createWithEnrollment.mock.calls[0][2]).not.toHaveProperty(
      'value',
    );
  });

  it('maps hostname uniqueness errors to VM_HOSTNAME_CONFLICT', async () => {
    const repository = createRepositoryMock();
    repository.createWithEnrollment.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate hostname', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['organizationId', 'hostname'] },
      }),
    );
    const secretService = {
      generate: vi.fn().mockReturnValue({
        value: PLAINTEXT_TOKEN,
        hash: 'hash',
      }),
    };
    const service = new VmsService(
      repository as unknown as VmsRepository,
      secretService as unknown as SecretService,
    );

    await expect(
      service.create(ORG_A, { hostname: 'db-prod-01' }),
    ).rejects.toMatchObject({
      code: 'VM_HOSTNAME_CONFLICT',
    });
    await expect(
      service.create(ORG_A, { hostname: 'db-prod-01' }),
    ).rejects.toBeInstanceOf(ApplicationConflictError);
  });

  it('maps missing VM reads, updates, and deletes to RESOURCE_NOT_FOUND', async () => {
    const repository = createRepositoryMock();
    repository.getById.mockResolvedValue(null);
    repository.update.mockRejectedValue({ code: 'P2025' });
    repository.remove.mockRejectedValue({ code: 'P2025' });
    const service = new VmsService(
      repository as unknown as VmsRepository,
      new SecretService(),
    );

    await expect(service.get(ORG_A, VM_A)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(
      service.update(ORG_A, VM_A, { hostname: 'new-host' }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(service.remove(ORG_A, VM_A)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(service.get(ORG_A, VM_A)).rejects.toBeInstanceOf(
      ApplicationNotFoundError,
    );
  });

  it('maps cross-tenant tag associations to RESOURCE_NOT_FOUND', async () => {
    const repository = createRepositoryMock();
    repository.addTag.mockRejectedValue({ code: 'P2025' });
    repository.updateTag.mockRejectedValue({ code: 'P2025' });
    repository.removeTag.mockRejectedValue({ code: 'P2025' });
    const service = new VmsService(
      repository as unknown as VmsRepository,
      new SecretService(),
    );
    const input: VmTagInput = { key: 'env', value: 'production' };

    await expect(service.addTag(ORG_A, VM_A, input)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(
      service.updateTag(
        ORG_A,
        VM_A,
        '00000000-0000-4000-8000-000000000003',
        input,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      service.removeTag(ORG_A, VM_A, '00000000-0000-4000-8000-000000000003'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('passes organization-scoped list and update inputs through unchanged', async () => {
    const repository = createRepositoryMock();
    const service = new VmsService(
      repository as unknown as VmsRepository,
      new SecretService(),
    );
    const filters = { page: 2, pageSize: 25, tags: [] };
    const update: VmUpdateInput = { ipAddress: null };
    const create: VmCreateInput = { hostname: 'db-prod-01' };
    repository.list.mockResolvedValue({
      items: [],
      page: 2,
      pageSize: 25,
      total: 0,
    });
    repository.update.mockResolvedValue(vmRecord);

    await expect(service.list(ORG_A, filters)).resolves.toEqual({
      items: [],
      page: 2,
      pageSize: 25,
      total: 0,
    });
    await expect(service.update(ORG_A, VM_A, update)).resolves.toEqual(
      vmRecord,
    );
    expect(repository.list).toHaveBeenCalledWith(ORG_A, filters);
    expect(repository.update).toHaveBeenCalledWith(ORG_A, VM_A, update);
    expect(create).toEqual({ hostname: 'db-prod-01' });
  });

  it('reissues a token with a 24-hour TTL and passes only its hash to the repository', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    const repository = createRepositoryMock();
    const enrollmentRepository = { issueToken: vi.fn() };
    const secretService = {
      generate: vi.fn().mockReturnValue({
        value: PLAINTEXT_TOKEN,
        hash: 'new-token-hash',
      }),
    };
    enrollmentRepository.issueToken.mockResolvedValue({
      tokenId: 'token-2',
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    const service = new (
      VmsService as unknown as new (...args: unknown[]) => VmsService
    )(repository, secretService, enrollmentRepository);

    await expect(service.reissueEnrollmentToken(ORG_A, VM_A)).resolves.toEqual({
      tokenId: 'token-2',
      token: PLAINTEXT_TOKEN,
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(secretService.generate).toHaveBeenCalledWith('ENR_');
    expect(enrollmentRepository.issueToken).toHaveBeenCalledWith(ORG_A, VM_A, {
      hash: 'new-token-hash',
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(enrollmentRepository.issueToken.mock.calls[0][2]).not.toHaveProperty(
      'value',
    );
  });

  it('does not expose a generated plaintext token when reissue fails', async () => {
    const repository = createRepositoryMock();
    const enrollmentRepository = { issueToken: vi.fn() };
    const secretService = {
      generate: vi.fn().mockReturnValue({
        value: PLAINTEXT_TOKEN,
        hash: 'new-token-hash',
      }),
    };
    enrollmentRepository.issueToken.mockRejectedValue({ code: 'P2025' });
    const service = new (
      VmsService as unknown as new (...args: unknown[]) => VmsService
    )(repository, secretService, enrollmentRepository);

    await expect(
      service.reissueEnrollmentToken(ORG_A, VM_A),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(
      JSON.stringify(enrollmentRepository.issueToken.mock.results),
    ).not.toContain(PLAINTEXT_TOKEN);
  });

  it('revokes an agent with the organization and VM scope and returns no credential', async () => {
    const repository = createRepositoryMock();
    const enrollmentRepository = { revokeAgent: vi.fn() };
    const service = new (
      VmsService as unknown as new (...args: unknown[]) => VmsService
    )(repository, new SecretService(), enrollmentRepository);

    await expect(service.revokeAgent(ORG_A, VM_A)).resolves.toBeUndefined();
    expect(enrollmentRepository.revokeAgent).toHaveBeenCalledWith(
      ORG_A,
      VM_A,
      expect.any(Date),
    );
    expect(
      JSON.stringify(enrollmentRepository.revokeAgent.mock.results),
    ).not.toContain('credentialHash');
  });

  it('maps a missing agent during revoke to RESOURCE_NOT_FOUND', async () => {
    const repository = createRepositoryMock();
    const enrollmentRepository = { revokeAgent: vi.fn() };
    enrollmentRepository.revokeAgent.mockRejectedValue({ code: 'P2025' });
    const service = new (
      VmsService as unknown as new (...args: unknown[]) => VmsService
    )(repository, new SecretService(), enrollmentRepository);

    await expect(service.revokeAgent(ORG_A, VM_A)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});
