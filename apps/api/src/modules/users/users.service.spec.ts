import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationConflictError } from '../../common/errors/application-conflict.error.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import { USER_SELECT, UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

type UserModel = {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
};

type PrismaMock = {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
};

function createPrismaMock(): PrismaMock {
  return {
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  };
}

describe('UsersRepository', () => {
  let prisma: PrismaMock;
  let repository: UsersRepository;

  beforeEach(() => {
    prisma = createPrismaMock();
    repository = new UsersRepository(prisma as unknown as PrismaService);
  });

  it('resolves a local user by the immutable Cognito subject', async () => {
    const user: UserModel = {
      id: 'user-1',
      cognitoSub: 'cognito-sub-1',
      email: 'person@example.com',
      displayName: 'Person',
    };
    prisma.user.findUnique.mockResolvedValue(user);

    await expect(repository.findByCognitoSub('cognito-sub-1')).resolves.toEqual(
      user,
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { cognitoSub: 'cognito-sub-1' },
      select: USER_SELECT,
    });
  });

  it('upserts only the synchronized Cognito profile fields', async () => {
    const user: UserModel = {
      id: 'user-1',
      cognitoSub: 'cognito-sub-1',
      email: 'person@example.com',
      displayName: null,
    };
    prisma.user.upsert.mockResolvedValue(user);

    await expect(
      repository.upsertFromCognito({
        cognitoSub: 'cognito-sub-1',
        email: 'person@example.com',
      }),
    ).resolves.toEqual(user);

    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { cognitoSub: 'cognito-sub-1' },
      create: {
        cognitoSub: 'cognito-sub-1',
        email: 'person@example.com',
      },
      update: {
        email: 'person@example.com',
      },
      select: USER_SELECT,
    });

    const query = prisma.user.upsert.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(query).not.toHaveProperty('password');
    expect(query).not.toHaveProperty('accessToken');
    expect(query).not.toHaveProperty('refreshToken');
  });
});

describe('UsersService', () => {
  it('maps a Cognito-sub unique violation to a stable conflict error', async () => {
    const prisma = createPrismaMock();
    prisma.user.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['cognitoSub'] },
      }),
    );
    const repository = new UsersRepository(prisma as unknown as PrismaService);
    const service = new UsersService(repository);

    await expect(
      service.upsertFromCognito({
        cognitoSub: 'cognito-sub-1',
        email: 'person@example.com',
      }),
    ).rejects.toBeInstanceOf(ApplicationConflictError);

    await expect(
      service.upsertFromCognito({
        cognitoSub: 'cognito-sub-1',
        email: 'person@example.com',
      }),
    ).rejects.toMatchObject({
      code: 'USER_COGNITO_SUB_CONFLICT',
    });
  });
});
