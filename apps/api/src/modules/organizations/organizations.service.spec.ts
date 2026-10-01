import { Prisma, Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationConflictError } from '../../common/errors/application-conflict.error.js';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import {
  ORGANIZATION_SELECT,
  OrganizationsRepository,
} from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';

type TransactionMock = {
  organization: {
    create: ReturnType<typeof vi.fn>;
  };
  membership: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

type PrismaMock = {
  $transaction: ReturnType<typeof vi.fn>;
  organization: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  membership: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

function createTransactionMock(): TransactionMock {
  return {
    organization: {
      create: vi.fn(),
    },
    membership: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
}

function createPrismaMock(): PrismaMock {
  return {
    $transaction: vi.fn(),
    organization: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    membership: {
      findMany: vi.fn(),
    },
  };
}

describe('OrganizationsRepository', () => {
  let prisma: PrismaMock;
  let repository: OrganizationsRepository;

  beforeEach(() => {
    prisma = createPrismaMock();
    repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
  });

  it('projects organizations and membership roles for a user', async () => {
    prisma.membership.findMany.mockResolvedValue([
      {
        role: Role.ADMIN,
        organization: {
          id: 'org-1',
          name: 'CloudOps',
          slug: 'cloudops',
        },
      },
    ]);

    await expect(repository.findForUser('user-1')).resolves.toEqual([
      {
        id: 'org-1',
        name: 'CloudOps',
        slug: 'cloudops',
        role: Role.ADMIN,
      },
    ]);
    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: {
        role: true,
        organization: { select: ORGANIZATION_SELECT },
      },
    });
  });

  it('gets an organization using an explicit safe projection', async () => {
    const organization = {
      id: 'org-1',
      name: 'CloudOps',
      slug: 'cloudops',
    };
    prisma.organization.findUnique.mockResolvedValue(organization);

    await expect(repository.getById('org-1')).resolves.toEqual(organization);
    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: ORGANIZATION_SELECT,
    });
  });

  it('updates only supplied organization fields', async () => {
    const organization = {
      id: 'org-1',
      name: 'Updated CloudOps',
      slug: 'updated-cloudops',
    };
    prisma.organization.update.mockResolvedValue(organization);

    await expect(
      repository.update('org-1', { name: 'Updated CloudOps' }),
    ).resolves.toEqual(organization);
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { name: 'Updated CloudOps' },
      select: ORGANIZATION_SELECT,
    });
  });
});

describe('OrganizationsService', () => {
  it('provisions one personal organization and ADMIN membership in a transaction', async () => {
    const prisma = createPrismaMock();
    const transaction = createTransactionMock();
    transaction.membership.findFirst.mockResolvedValue(null);
    transaction.organization.create.mockImplementation(({ data }) => ({
      id: 'org-1',
      name: data.name,
      slug: data.slug,
    }));
    transaction.membership.create.mockResolvedValue({ id: 'membership-1' });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new OrganizationsService(repository);

    await (
      service as unknown as {
        provisionPersonalOrganization: (
          userId: string,
          verifiedEmail: string,
        ) => Promise<unknown>;
      }
    ).provisionPersonalOrganization('user-1', 'phic0206@ut.edu.vn');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(transaction.organization.create).toHaveBeenCalledTimes(1);
    expect(transaction.organization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'phic0206',
        slug: expect.stringMatching(/^phic0206-[a-z0-9]{6}$/),
      }),
    });
    expect(transaction.membership.create).toHaveBeenCalledTimes(1);
    const membershipData = transaction.membership.create.mock.calls[0][0].data;
    expect(membershipData.role).toBe(Role.ADMIN);
    expect(
      membershipData.userId ?? membershipData.user?.connect?.id,
    ).toBe('user-1');
    expect(
      membershipData.organizationId ?? membershipData.organization?.connect?.id,
    ).toBe('org-1');
  });

  it('does not fail provisioning when cache deletion rejects', async () => {
    const prisma = createPrismaMock();
    const transaction = createTransactionMock();
    transaction.membership.findFirst.mockResolvedValue({ id: 'membership-1' });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const cache = {
      delete: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const service = new OrganizationsService(
      repository,
      cache as unknown as CacheService,
    );

    await expect(
      (
        service as unknown as {
          provisionPersonalOrganization: (
            userId: string,
            verifiedEmail: string,
          ) => Promise<unknown>;
        }
      ).provisionPersonalOrganization('user-1', 'phic0206@ut.edu.vn'),
    ).resolves.toBeUndefined();
    expect(cache.delete).toHaveBeenCalledWith('cloudops:v1:me:user-1');
  });

  it('returns without creating anything when the user already has a membership', async () => {
    const prisma = createPrismaMock();
    const transaction = createTransactionMock();
    transaction.membership.findFirst.mockResolvedValue({ id: 'membership-1' });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(transaction),
    );
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new OrganizationsService(repository);

    await (
      service as unknown as {
        provisionPersonalOrganization: (
          userId: string,
          verifiedEmail: string,
        ) => Promise<unknown>;
      }
    ).provisionPersonalOrganization('user-1', 'phic0206@ut.edu.vn');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(transaction.organization.create).not.toHaveBeenCalled();
    expect(transaction.membership.create).not.toHaveBeenCalled();
  });

  it('retries with a new slug when the provisioning transaction collides on the slug', async () => {
    const prisma = createPrismaMock();
    const firstTransaction = createTransactionMock();
    const secondTransaction = createTransactionMock();
    const slugs: string[] = [];
    firstTransaction.membership.findFirst.mockResolvedValue(null);
    secondTransaction.membership.findFirst.mockResolvedValue(null);
    firstTransaction.organization.create.mockImplementation(({ data }) => {
      slugs.push(data.slug);
      return { id: 'org-first', name: data.name, slug: data.slug };
    });
    secondTransaction.organization.create.mockImplementation(({ data }) => {
      slugs.push(data.slug);
      return { id: 'org-second', name: data.name, slug: data.slug };
    });
    firstTransaction.membership.create.mockResolvedValue({
      id: 'membership-first',
    });
    secondTransaction.membership.create.mockResolvedValue({
      id: 'membership-second',
    });
    const duplicateSlug = new Prisma.PrismaClientKnownRequestError(
      'duplicate slug',
      {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['slug'] },
      },
    );
    prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(firstTransaction);
        throw duplicateSlug;
      })
      .mockImplementationOnce(async (callback) => callback(secondTransaction));
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new OrganizationsService(repository);

    await (
      service as unknown as {
        provisionPersonalOrganization: (
          userId: string,
          verifiedEmail: string,
        ) => Promise<unknown>;
      }
    ).provisionPersonalOrganization('user-1', 'phic0206@ut.edu.vn');

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(slugs).toHaveLength(2);
    expect(slugs[0]).toMatch(/^phic0206-[a-z0-9]{6}$/);
    expect(slugs[1]).toMatch(/^phic0206-[a-z0-9]{6}$/);
    expect(secondTransaction.membership.create).toHaveBeenCalledTimes(1);
  });

  it('retries provisioning after a serializable transaction conflict', async () => {
    const prisma = createPrismaMock();
    const retryTransaction = createTransactionMock();
    retryTransaction.membership.findFirst.mockResolvedValue(null);
    retryTransaction.organization.create.mockImplementation(({ data }) => ({
      id: 'org-retry',
      name: data.name,
      slug: data.slug,
    }));
    retryTransaction.membership.create.mockResolvedValue({
      id: 'membership-retry',
    });
    const serializationConflict = new Prisma.PrismaClientKnownRequestError(
      'serialization conflict',
      {
        code: 'P2034',
        clientVersion: '7.10.0',
      },
    );
    prisma.$transaction
      .mockRejectedValueOnce(serializationConflict)
      .mockImplementationOnce(async (callback) => callback(retryTransaction));
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new OrganizationsService(repository);

    await expect(
      (
        service as unknown as {
          provisionPersonalOrganization: (
            userId: string,
            verifiedEmail: string,
          ) => Promise<unknown>;
        }
      ).provisionPersonalOrganization('user-1', 'phic0206@ut.edu.vn'),
    ).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(retryTransaction.organization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'phic0206',
        slug: expect.stringMatching(/^phic0206-[a-z0-9]{6}$/),
      }),
    });
    expect(retryTransaction.membership.create).toHaveBeenCalledTimes(1);
  });

  it('retries a membership collision and observes the existing membership', async () => {
    const prisma = createPrismaMock();
    const firstTransaction = createTransactionMock();
    const retryTransaction = createTransactionMock();
    firstTransaction.membership.findFirst.mockResolvedValue(null);
    firstTransaction.organization.create.mockImplementation(({ data }) => ({
      id: 'org-first',
      name: data.name,
      slug: data.slug,
    }));
    const duplicateMembership = new Prisma.PrismaClientKnownRequestError(
      'duplicate membership',
      {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['userId', 'organizationId'] },
      },
    );
    firstTransaction.membership.create.mockRejectedValue(duplicateMembership);
    retryTransaction.membership.findFirst.mockResolvedValue({
      id: 'membership-existing',
    });
    prisma.$transaction
      .mockImplementationOnce(async (callback) => callback(firstTransaction))
      .mockImplementationOnce(async (callback) => callback(retryTransaction));
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new OrganizationsService(repository);

    await expect(
      (
        service as unknown as {
          provisionPersonalOrganization: (
            userId: string,
            verifiedEmail: string,
          ) => Promise<unknown>;
        }
      ).provisionPersonalOrganization('user-1', 'phic0206@ut.edu.vn'),
    ).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(firstTransaction.organization.create).toHaveBeenCalledTimes(1);
    expect(retryTransaction.membership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(retryTransaction.organization.create).not.toHaveBeenCalled();
    expect(retryTransaction.membership.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate organization slug to a stable conflict error', async () => {
    const prisma = createPrismaMock();
    prisma.organization.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['slug'] },
      }),
    );
    const repository = new OrganizationsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new OrganizationsService(repository);

    await expect(
      service.update('org-1', { slug: 'existing-slug' }),
    ).rejects.toBeInstanceOf(ApplicationConflictError);
    await expect(
      service.update('org-1', { slug: 'existing-slug' }),
    ).rejects.toMatchObject({
      code: 'ORGANIZATION_SLUG_CONFLICT',
    });
  });
});
