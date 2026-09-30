import { Prisma, Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationConflictError } from '../../common/errors/application-conflict.error.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import {
  ORGANIZATION_SELECT,
  OrganizationsRepository,
} from './organizations.repository.js';
import { OrganizationsService } from './organizations.service.js';

type PrismaMock = {
  organization: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  membership: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

function createPrismaMock(): PrismaMock {
  return {
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
