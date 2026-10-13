import { AgentStatus, EnrollmentTokenStatus, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import { EnrollmentRepository } from './enrollment.repository.js';

const ORG_A = '00000000-0000-4000-8000-000000000001';
const VM_A = '00000000-0000-4000-8000-000000000002';
const TOKEN_HASH_A = 'a'.repeat(64);
const TOKEN_HASH_B = 'b'.repeat(64);

function createTransactionMock() {
  return {
    $queryRaw: vi.fn(),
    vm: {
      update: vi.fn(),
    },
    enrollmentToken: {
      updateMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agent: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
}

describe('EnrollmentRepository', () => {
  it('locks the tenant VM, revokes every active token, and creates a hash-only token', async () => {
    const transaction = createTransactionMock();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: VM_A }]);
    transaction.enrollmentToken.create.mockResolvedValue({
      id: 'token-new',
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );
    const now = new Date('2026-10-01T00:00:00.000Z');
    const expiresAt = new Date('2026-10-02T00:00:00.000Z');

    await expect(
      repository.issueToken(ORG_A, VM_A, {
        hash: 'hash-new',
        expiresAt,
      }),
    ).resolves.toEqual({
      tokenId: 'token-new',
      expiresAt,
    });

    const tokenLockQuery = transaction.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(tokenLockQuery.sql ?? tokenLockQuery.strings?.join('')).toMatch(
      /EnrollmentToken/i,
    );
    expect(tokenLockQuery.sql ?? tokenLockQuery.strings?.join('')).toMatch(
      /FOR UPDATE/i,
    );
    expect(tokenLockQuery.values).toEqual([
      ORG_A,
      VM_A,
      EnrollmentTokenStatus.ACTIVE,
    ]);
    const vmLockQuery = transaction.$queryRaw.mock.calls[2][0] as Prisma.Sql;
    expect(vmLockQuery.sql ?? vmLockQuery.strings?.join('')).toMatch(/Vm/i);
    expect(vmLockQuery.sql ?? vmLockQuery.strings?.join('')).toMatch(
      /FOR UPDATE/i,
    );
    expect(vmLockQuery.values).toEqual([VM_A, ORG_A]);
    expect(transaction.enrollmentToken.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_A,
        vmId: VM_A,
        status: EnrollmentTokenStatus.ACTIVE,
      },
      data: {
        status: EnrollmentTokenStatus.REVOKED,
        revokedAt: now,
      },
    });
    expect(transaction.enrollmentToken.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_A,
        vmId: VM_A,
        tokenHash: 'hash-new',
        status: EnrollmentTokenStatus.ACTIVE,
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });
  });

  it('refuses a new enrollment token when an active agent already exists', async () => {
    const transaction = createTransactionMock();
    transaction.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: VM_A }]);
    transaction.agent.findFirst.mockResolvedValue({
      status: AgentStatus.ACTIVE,
    });
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.issueToken(ORG_A, VM_A, {
        hash: 'hash-new',
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_ALREADY_ENROLLED' });
    expect(transaction.enrollmentToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.enrollmentToken.create).not.toHaveBeenCalled();
  });

  it('raises P2025 when the organization-scoped VM does not exist', async () => {
    const transaction = createTransactionMock();
    transaction.$queryRaw.mockResolvedValue([]);
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.issueToken(ORG_A, VM_A, {
        hash: 'hash-new',
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(transaction.enrollmentToken.updateMany).not.toHaveBeenCalled();
    expect(transaction.enrollmentToken.create).not.toHaveBeenCalled();
  });

  it('revokes an active agent without selecting or deleting its credential hash', async () => {
    const transaction = createTransactionMock();
    transaction.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      status: AgentStatus.ACTIVE,
    });
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );
    const now = new Date('2026-10-01T00:00:00.000Z');

    await expect(
      repository.revokeAgent(ORG_A, VM_A, now),
    ).resolves.toBeUndefined();
    expect(transaction.agent.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG_A, vmId: VM_A },
      select: { id: true, status: true },
    });
    expect(transaction.agent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'agent-1',
        organizationId: ORG_A,
        vmId: VM_A,
        status: AgentStatus.ACTIVE,
      },
      data: {
        status: AgentStatus.REVOKED,
        revokedAt: now,
      },
    });
    expect(
      JSON.stringify(transaction.agent.updateMany.mock.calls),
    ).not.toContain('credentialHash');
  });

  it('is idempotent for an already revoked agent and raises P2025 when absent', async () => {
    const transaction = createTransactionMock();
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );
    transaction.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      status: AgentStatus.REVOKED,
    });

    await expect(
      repository.revokeAgent(ORG_A, VM_A, new Date()),
    ).resolves.toBeUndefined();
    expect(transaction.agent.updateMany).not.toHaveBeenCalled();

    transaction.agent.findFirst.mockResolvedValue(null);
    await expect(
      repository.revokeAgent(ORG_A, VM_A, new Date()),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('returns null without querying when the token hash is malformed', async () => {
    const transaction = createTransactionMock();
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: 'not-a-sha256-hash',
        credentialHash: 'credential-hash-only',
        now: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).resolves.toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('locks token then VM in a serializable transaction and consumes only after enrollment succeeds', async () => {
    const transaction = createTransactionMock();
    const now = new Date('2026-10-01T00:00:00.000Z');
    const plaintextCredential = `AGT_${'x'.repeat(43)}`;
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-1',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    transaction.agent.findFirst.mockResolvedValue(null);
    transaction.agent.create.mockResolvedValue({ id: 'agent-1' });

    const prisma = {
      $transaction: vi.fn(
        async (
          callback: (tx: typeof transaction) => unknown,
          _options: unknown,
        ) => callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-only',
        os: 'Ubuntu 24.04',
        now,
      }),
    ).resolves.toEqual({
      agentId: 'agent-1',
      organizationId: ORG_A,
      vmId: VM_A,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
    const tokenLock = transaction.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    const vmLock = transaction.$queryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(tokenLock.sql ?? tokenLock.strings?.join('')).toMatch(
      /EnrollmentToken.*FOR UPDATE/is,
    );
    expect(tokenLock.values).toEqual([TOKEN_HASH_A]);
    expect(vmLock.sql ?? vmLock.strings?.join('')).toMatch(/Vm.*FOR UPDATE/is);
    expect(vmLock.values).toEqual([VM_A, ORG_A]);
    expect(transaction.agent.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_A,
        vmId: VM_A,
        credentialHash: 'credential-hash-only',
        status: AgentStatus.ACTIVE,
        enrolledAt: now,
        revokedAt: null,
      },
      select: { id: true },
    });
    expect(transaction.vm.update).toHaveBeenCalledWith({
      where: { id: VM_A },
      data: { os: 'Ubuntu 24.04' },
    });
    expect(transaction.enrollmentToken.update).toHaveBeenCalledWith({
      where: { id: 'token-1' },
      data: {
        status: EnrollmentTokenStatus.CONSUMED,
        consumedAt: now,
      },
    });
    expect(JSON.stringify(transaction.agent.create.mock.calls)).not.toContain(
      plaintextCredential,
    );
  });

  it.each([
    ['missing', []],
    [
      'consumed',
      [
        {
          id: 'token-1',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.CONSUMED,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ],
    ],
    [
      'revoked',
      [
        {
          id: 'token-1',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.REVOKED,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ],
    ],
    [
      'expired',
      [
        {
          id: 'token-1',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    ],
  ])(
    'returns null for a %s token without touching agent or VM state',
    async (_label, tokenRows) => {
      const transaction = createTransactionMock();
      transaction.$queryRaw.mockResolvedValue(tokenRows);
      const prisma = {
        $transaction: vi.fn(
          async (callback: (tx: typeof transaction) => unknown) =>
            callback(transaction),
        ),
      };
      const repository = new EnrollmentRepository(
        prisma as unknown as PrismaService,
      );

      await expect(
        repository.consumeAndEnroll({
          tokenHash: TOKEN_HASH_A,
          credentialHash: 'credential-hash-only',
          now: new Date('2026-10-01T00:00:00.000Z'),
        }),
      ).resolves.toBeNull();
      expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
      expect(transaction.agent.findFirst).not.toHaveBeenCalled();
      expect(transaction.vm.update).not.toHaveBeenCalled();
      expect(transaction.enrollmentToken.update).not.toHaveBeenCalled();
    },
  );

  it('rejects an active agent without consuming the valid token', async () => {
    const transaction = createTransactionMock();
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-1',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    transaction.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      status: AgentStatus.ACTIVE,
    });
    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-only',
        now: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_ALREADY_ENROLLED',
      message: 'Agent is already enrolled',
    });
    expect(transaction.enrollmentToken.update).not.toHaveBeenCalled();
    expect(transaction.agent.create).not.toHaveBeenCalled();
    expect(transaction.agent.update).not.toHaveBeenCalled();
  });

  it('rotates a revoked agent with a new hash and preserves the VM OS when absent', async () => {
    const transaction = createTransactionMock();
    const now = new Date('2026-10-01T00:00:00.000Z');
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-2',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    transaction.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      status: AgentStatus.REVOKED,
    });
    transaction.agent.update.mockResolvedValue({ id: 'agent-1' });

    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_B,
        credentialHash: 'credential-hash-2',
        now,
      }),
    ).resolves.toEqual({
      agentId: 'agent-1',
      organizationId: ORG_A,
      vmId: VM_A,
    });
    expect(transaction.agent.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: {
        credentialHash: 'credential-hash-2',
        status: AgentStatus.ACTIVE,
        enrolledAt: now,
        revokedAt: null,
      },
      select: { id: true },
    });
    expect(transaction.agent.create).not.toHaveBeenCalled();
    expect(transaction.vm.update).not.toHaveBeenCalled();
  });

  it('refreshes VM OS metadata when a later revoked-agent enrollment supplies OS', async () => {
    const transaction = createTransactionMock();
    const now = new Date('2026-10-01T00:00:00.000Z');
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-3',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    transaction.agent.findFirst.mockResolvedValue({
      id: 'agent-1',
      status: AgentStatus.REVOKED,
    });
    transaction.agent.update.mockResolvedValue({ id: 'agent-1' });

    const prisma = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-3',
        os: 'Windows Server 2025',
        now,
      }),
    ).resolves.toEqual({
      agentId: 'agent-1',
      organizationId: ORG_A,
      vmId: VM_A,
    });
    expect(transaction.vm.update).toHaveBeenCalledWith({
      where: { id: VM_A },
      data: { os: 'Windows Server 2025' },
    });
  });

  it('serializes same-token and same-VM two-token attempts with token and VM locks', async () => {
    const now = new Date('2026-10-01T00:00:00.000Z');
    const firstTransaction = createTransactionMock();
    firstTransaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-first',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    firstTransaction.agent.findFirst.mockResolvedValue(null);
    firstTransaction.agent.create.mockResolvedValue({ id: 'agent-first' });

    const secondTransaction = createTransactionMock();
    secondTransaction.$queryRaw.mockResolvedValueOnce([]);
    let sameTokenCall = 0;
    const sameTokenPrisma = {
      $transaction: vi.fn(
        async (
          callback: (tx: typeof firstTransaction) => unknown,
          _options: unknown,
        ) =>
          callback(
            sameTokenCall++ === 0 ? firstTransaction : secondTransaction,
          ),
      ),
    };
    const sameTokenRepository = new EnrollmentRepository(
      sameTokenPrisma as unknown as PrismaService,
    );
    const sameTokenResults = await Promise.all([
      sameTokenRepository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-first',
        now,
      }),
      (async () => {
        const result = await sameTokenRepository.consumeAndEnroll({
          tokenHash: TOKEN_HASH_A,
          credentialHash: 'credential-hash-second',
          now,
        });
        return result;
      })(),
    ]);
    expect(sameTokenResults).toEqual([
      {
        agentId: 'agent-first',
        organizationId: ORG_A,
        vmId: VM_A,
      },
      null,
    ]);
    expect(sameTokenPrisma.$transaction).toHaveBeenCalledTimes(2);
    expect(firstTransaction.$queryRaw).toHaveBeenCalledTimes(2);
    expect(secondTransaction.$queryRaw).toHaveBeenCalledTimes(1);

    const firstTwoTokenTransaction = createTransactionMock();
    firstTwoTokenTransaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-first',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    firstTwoTokenTransaction.agent.findFirst.mockResolvedValue(null);
    firstTwoTokenTransaction.agent.create.mockResolvedValue({
      id: 'agent-first',
    });
    const secondTwoTokenTransaction = createTransactionMock();
    secondTwoTokenTransaction.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'token-second',
          organizationId: ORG_A,
          vmId: VM_A,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([{ id: VM_A }]);
    secondTwoTokenTransaction.agent.findFirst.mockResolvedValue({
      id: 'agent-first',
      status: AgentStatus.ACTIVE,
    });
    const twoTokenTransactions = [
      firstTwoTokenTransaction,
      secondTwoTokenTransaction,
    ];
    const twoTokenPrisma = {
      $transaction: vi.fn(
        async (
          callback: (tx: (typeof twoTokenTransactions)[number]) => unknown,
          _options: unknown,
        ) => callback(twoTokenTransactions.shift()!),
      ),
    };
    const twoTokenRepository = new EnrollmentRepository(
      twoTokenPrisma as unknown as PrismaService,
    );
    const twoTokenResults = await Promise.allSettled([
      twoTokenRepository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-first',
        now,
      }),
      twoTokenRepository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_B,
        credentialHash: 'credential-hash-second',
        now,
      }),
    ]);
    expect(
      twoTokenResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      twoTokenResults.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      secondTwoTokenTransaction.enrollmentToken.update,
    ).not.toHaveBeenCalled();
    expect(secondTwoTokenTransaction.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('retries serialization failures and preserves the database error after exhaustion', async () => {
    const serializationError = new Prisma.PrismaClientKnownRequestError(
      'serialization failure',
      { code: 'P2034', clientVersion: Prisma.prismaVersion.client },
    );
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError)
        .mockRejectedValueOnce(serializationError),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-only',
        now: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).rejects.toBe(serializationError);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('maps a unique agent race to the active-agent conflict', async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError(
      'unique constraint',
      { code: 'P2002', clientVersion: Prisma.prismaVersion.client },
    );
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(uniqueError),
    };
    const repository = new EnrollmentRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.consumeAndEnroll({
        tokenHash: TOKEN_HASH_A,
        credentialHash: 'credential-hash-only',
        now: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'AGENT_ALREADY_ENROLLED',
      message: 'Agent is already enrolled',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
