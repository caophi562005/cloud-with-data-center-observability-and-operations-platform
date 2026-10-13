import { AgentStatus, EnrollmentTokenStatus, Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import { EnrollmentRepository } from './enrollment.repository.js';
const NOW = new Date('2026-10-03T00:00:00Z');
const EXPIRES = new Date('2026-10-04T00:00:00Z');
function fixture() {
  const current = { id: 'old', tokenHash: 'old-hash', expiresAt: EXPIRES };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'vm' }]),
    agent: { findFirst: vi.fn().mockResolvedValue(null) },
    enrollmentToken: {
      findFirst: vi.fn().mockResolvedValue(current),
      updateMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'new', expiresAt: EXPIRES }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const repository = new EnrollmentRepository(
    prisma as unknown as PrismaService,
  );
  const hooks = {
    read: vi.fn().mockResolvedValue({
      tokenId: 'old',
      hash: 'old-hash',
      expiresAt: EXPIRES,
    }),
    write: vi.fn(),
  };
  return { repository, tx, hooks };
}
describe('Enrollment token reuse under tenant VM lock', () => {
  it('serializes issuance and validates cached token against the active DB row without extending expiry', async () => {
    const { repository, tx, hooks } = fixture();
    expect(
      await repository.issueToken(
        'org',
        'vm',
        { hash: 'new-hash', expiresAt: EXPIRES },
        NOW,
        hooks,
      ),
    ).toEqual({ tokenId: 'old', expiresAt: EXPIRES });
    const lock = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(lock.sql).toContain('pg_advisory_xact_lock');
    expect(lock.values).toEqual(['vm-enrollment:org:vm']);
    expect(hooks.read).toHaveBeenCalledWith({
      tokenId: 'old',
      expiresAt: EXPIRES,
    });
    expect(tx.enrollmentToken.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org',
        vmId: 'vm',
        status: EnrollmentTokenStatus.ACTIVE,
        expiresAt: { gt: NOW },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, tokenHash: true, expiresAt: true },
    });
    expect(tx.enrollmentToken.create).not.toHaveBeenCalled();
    expect(tx.enrollmentToken.updateMany).not.toHaveBeenCalled();
    expect(hooks.write).not.toHaveBeenCalled();
  });
  it('rotates when the DB token expires while awaiting the reuse hook', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { repository, tx, hooks } = fixture();
      const expiresAt = new Date(NOW.getTime() + 100);
      tx.enrollmentToken.findFirst.mockResolvedValue({
        id: 'old',
        tokenHash: 'old-hash',
        expiresAt,
      });
      hooks.read.mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { tokenId: 'old', hash: 'old-hash', expiresAt };
      });
      const issuing = repository.issueToken(
        'org',
        'vm',
        { hash: 'new-hash', expiresAt: EXPIRES },
        NOW,
        hooks,
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(await issuing).toEqual({ tokenId: 'new', expiresAt: EXPIRES });
      expect(hooks.write).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    null,
    { tokenId: 'other', hash: 'old-hash', expiresAt: EXPIRES },
    { tokenId: 'old', hash: 'wrong', expiresAt: EXPIRES },
    { tokenId: 'old', hash: 'old-hash', expiresAt: NOW },
  ])(
    'rotates when cache is missing or DB identity/hash/expiry mismatches',
    async (cached) => {
      const { repository, tx, hooks } = fixture();
      hooks.read.mockResolvedValue(cached);
      expect(
        await repository.issueToken(
          'org',
          'vm',
          { hash: 'new-hash', expiresAt: EXPIRES },
          NOW,
          hooks,
        ),
      ).toEqual({ tokenId: 'new', expiresAt: EXPIRES });
      expect(tx.enrollmentToken.updateMany).toHaveBeenCalled();
      expect(hooks.write).toHaveBeenCalledWith({
        tokenId: 'new',
        expiresAt: EXPIRES,
      });
    },
  );
  it('does not read revoked, consumed or expired cached tokens when no active row exists', async () => {
    const { repository, tx, hooks } = fixture();
    tx.enrollmentToken.findFirst.mockResolvedValue(null);
    await repository.issueToken(
      'org',
      'vm',
      { hash: 'new-hash', expiresAt: EXPIRES },
      NOW,
      hooks,
    );
    expect(hooks.read).not.toHaveBeenCalled();
    expect(tx.enrollmentToken.create).toHaveBeenCalled();
  });
  it('rejects active agent before cache access or generation, including calls outside the UI', async () => {
    const { repository, tx, hooks } = fixture();
    tx.agent.findFirst.mockResolvedValue({ status: AgentStatus.ACTIVE });
    await expect(
      repository.issueToken(
        'org',
        'vm',
        { hash: 'new-hash', expiresAt: EXPIRES },
        NOW,
        hooks,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_ALREADY_ENROLLED' });
    expect(hooks.read).not.toHaveBeenCalled();
    expect(tx.enrollmentToken.create).not.toHaveBeenCalled();
  });
});
