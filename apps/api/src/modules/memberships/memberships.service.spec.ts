import { Prisma, Role } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationConflictError } from '../../common/errors/application-conflict.error.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import {
  MEMBERSHIP_SELECT,
  MembershipsRepository,
} from './memberships.repository.js';
import { MembershipsService } from './memberships.service.js';

type PrismaMock = {
  membership: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function createPrismaMock(): PrismaMock {
  return {
    membership: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('MembershipsRepository', () => {
  let prisma: PrismaMock;
  let repository: MembershipsRepository;

  beforeEach(() => {
    prisma = createPrismaMock();
    repository = new MembershipsRepository(prisma as unknown as PrismaService);
  });

  it('lists safe member projections for an organization', async () => {
    prisma.membership.findMany.mockResolvedValue([
      {
        id: 'membership-1',
        userId: 'user-1',
        role: Role.OPERATOR,
        user: {
          id: 'user-1',
          email: 'operator@example.com',
          displayName: 'Operator',
        },
      },
    ]);

    await expect(repository.list('org-1')).resolves.toEqual([
      {
        id: 'membership-1',
        userId: 'user-1',
        email: 'operator@example.com',
        displayName: 'Operator',
        role: Role.OPERATOR,
      },
    ]);
    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      select: MEMBERSHIP_SELECT,
    });
  });

  it('creates a member through the organization/user relations', async () => {
    const member = {
      id: 'membership-1',
      userId: 'user-1',
      email: 'operator@example.com',
      displayName: 'Operator',
      role: Role.VIEWER,
    };
    prisma.membership.create.mockResolvedValue({
      id: member.id,
      userId: member.userId,
      role: member.role,
      user: {
        id: member.userId,
        email: member.email,
        displayName: member.displayName,
      },
    });

    await expect(
      repository.create('org-1', { userId: 'user-1', role: Role.VIEWER }),
    ).resolves.toEqual(member);
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: {
        organization: { connect: { id: 'org-1' } },
        user: { connect: { id: 'user-1' } },
        role: Role.VIEWER,
      },
      select: MEMBERSHIP_SELECT,
    });
  });

  it('updates a member role using the composite membership key', async () => {
    const member = {
      id: 'membership-1',
      userId: 'user-1',
      email: 'operator@example.com',
      displayName: 'Operator',
      role: Role.ADMIN,
    };
    prisma.membership.update.mockResolvedValue({
      id: member.id,
      userId: member.userId,
      role: member.role,
      user: {
        id: member.userId,
        email: member.email,
        displayName: member.displayName,
      },
    });

    await expect(
      repository.updateRole('org-1', 'user-1', Role.ADMIN),
    ).resolves.toEqual(member);
    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: {
        userId_organizationId: { userId: 'user-1', organizationId: 'org-1' },
      },
      data: { role: Role.ADMIN },
      select: MEMBERSHIP_SELECT,
    });
  });

  it('deletes a member using the composite membership key', async () => {
    prisma.membership.delete.mockResolvedValue({});

    await expect(repository.remove('org-1', 'user-1')).resolves.toBeUndefined();
    expect(prisma.membership.delete).toHaveBeenCalledWith({
      where: {
        userId_organizationId: { userId: 'user-1', organizationId: 'org-1' },
      },
    });
  });
});

describe('MembershipsService', () => {
  it('maps duplicate memberships to a stable conflict error', async () => {
    const prisma = createPrismaMock();
    prisma.membership.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['userId', 'organizationId'] },
      }),
    );
    const repository = new MembershipsRepository(
      prisma as unknown as PrismaService,
    );
    const service = new MembershipsService(repository);

    await expect(
      service.create('org-1', { userId: 'user-1', role: Role.VIEWER }),
    ).rejects.toBeInstanceOf(ApplicationConflictError);
    await expect(
      service.create('org-1', { userId: 'user-1', role: Role.VIEWER }),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_ALREADY_EXISTS',
    });
  });
});
