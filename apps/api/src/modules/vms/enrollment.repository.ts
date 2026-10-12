import { Injectable } from '@nestjs/common';
import { AgentStatus, EnrollmentTokenStatus, Prisma } from '@prisma/client';
import {
  ApplicationConflictError,
  hasPrismaErrorCode,
} from '../../common/errors/application-conflict.error.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import {
  DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS,
  type TokenSeed,
} from './vms.types.js';

@Injectable()
export class EnrollmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async issueToken(
    organizationId: string,
    vmId: string,
    seed: TokenSeed,
    now = new Date(
      seed.expiresAt.getTime() - DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS * 1000,
    ),
    reuse?: EnrollmentTokenReuse,
  ): Promise<{ tokenId: string; expiresAt: Date }> {
    const startedAt = Date.now();
    return this.prisma.$transaction(async (transaction) => {
      // Serialize issuance across replicas, including cache population. Keep the
      // token -> VM row-lock order shared with consumeAndEnroll to avoid deadlocks.
      await transaction.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`vm-enrollment:${organizationId}:${vmId}`}, 0))::text`,
      );
      await transaction.$queryRaw<{ id: string }[]>(
        Prisma.sql`
          SELECT "id"
          FROM "EnrollmentToken"
          WHERE "organizationId" = ${organizationId}
            AND "vmId" = ${vmId}
            AND "status" = ${EnrollmentTokenStatus.ACTIVE}
          FOR UPDATE
        `,
      );

      const lockedVm = await transaction.$queryRaw<{ id: string }[]>(
        Prisma.sql`
          SELECT "id"
          FROM "Vm"
          WHERE "id" = ${vmId}
            AND "organizationId" = ${organizationId}
          FOR UPDATE
        `,
      );
      if (lockedVm.length === 0) {
        throw prismaNotFoundError('VM not found');
      }

      const existingAgent = await transaction.agent.findFirst({
        where: { organizationId, vmId },
        select: { status: true },
      });
      if (existingAgent?.status === AgentStatus.ACTIVE) {
        throw activeAgentConflict();
      }

      if (reuse) {
        const current = await transaction.enrollmentToken.findFirst({
          where: {
            organizationId,
            vmId,
            status: EnrollmentTokenStatus.ACTIVE,
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, tokenHash: true, expiresAt: true },
        });
        if (current) {
          const cached = await reuse.read({
            tokenId: current.id,
            expiresAt: current.expiresAt,
          });
          if (
            cached?.tokenId === current.id &&
            cached.hash === current.tokenHash &&
            cached.expiresAt.getTime() === current.expiresAt.getTime() &&
            // Include time spent waiting for DB locks and Redis in the validity check.
            current.expiresAt.getTime() >
              now.getTime() + Math.max(0, Date.now() - startedAt)
          ) {
            return { tokenId: current.id, expiresAt: current.expiresAt };
          }
        }
      }

      await transaction.enrollmentToken.updateMany({
        where: {
          organizationId,
          vmId,
          status: EnrollmentTokenStatus.ACTIVE,
        },
        data: {
          status: EnrollmentTokenStatus.REVOKED,
          revokedAt: now,
        },
      });

      const token = await transaction.enrollmentToken.create({
        data: {
          organizationId,
          vmId,
          tokenHash: seed.hash,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: seed.expiresAt,
        },
        select: { id: true, expiresAt: true },
      });

      const issued = { tokenId: token.id, expiresAt: token.expiresAt };
      // Write while the issuance lock is held; the next request can reuse it.
      // Per-token cache keys keep a late write from overwriting newer tokens.
      await reuse?.write(issued);
      return issued;
    });
  }

  async consumeAndEnroll(input: {
    tokenHash: string;
    credentialHash: string;
    os?: string;
    now: Date;
  }): Promise<{
    agentId: string;
    organizationId: string;
    vmId: string;
  } | null> {
    if (!SHA256_HEX_PATTERN.test(input.tokenHash)) {
      return null;
    }

    for (let attempt = 0; attempt < MAX_CONSUME_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const tokenRows = await transaction.$queryRaw<
              EnrollmentTokenLockRow[]
            >(
              Prisma.sql`
            SELECT "id", "organizationId", "vmId", "status", "expiresAt"
            FROM "EnrollmentToken"
            WHERE "tokenHash" = ${input.tokenHash}
            FOR UPDATE
          `,
            );
            const token = tokenRows[0];
            if (
              !token ||
              token.status !== EnrollmentTokenStatus.ACTIVE ||
              token.expiresAt <= input.now
            ) {
              return null;
            }

            const lockedVm = await transaction.$queryRaw<{ id: string }[]>(
              Prisma.sql`
            SELECT "id"
            FROM "Vm"
            WHERE "id" = ${token.vmId}
              AND "organizationId" = ${token.organizationId}
            FOR UPDATE
          `,
            );
            if (lockedVm.length === 0) {
              return null;
            }

            const existingAgent = await transaction.agent.findFirst({
              where: {
                organizationId: token.organizationId,
                vmId: token.vmId,
              },
              select: { id: true, status: true },
            });
            if (existingAgent?.status === AgentStatus.ACTIVE) {
              throw activeAgentConflict();
            }

            const agentData = {
              credentialHash: input.credentialHash,
              status: AgentStatus.ACTIVE,
              enrolledAt: input.now,
              revokedAt: null,
            };
            const agent = existingAgent
              ? await transaction.agent.update({
                  where: { id: existingAgent.id },
                  data: agentData,
                  select: { id: true },
                })
              : await transaction.agent.create({
                  data: {
                    organizationId: token.organizationId,
                    vmId: token.vmId,
                    ...agentData,
                  },
                  select: { id: true },
                });

            if (input.os !== undefined) {
              await transaction.vm.update({
                where: { id: token.vmId },
                data: { os: input.os },
              });
            }

            await transaction.enrollmentToken.update({
              where: { id: token.id },
              data: {
                status: EnrollmentTokenStatus.CONSUMED,
                consumedAt: input.now,
              },
            });

            return {
              agentId: agent.id,
              organizationId: token.organizationId,
              vmId: token.vmId,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (hasPrismaErrorCode(error, 'P2034')) {
          if (attempt + 1 < MAX_CONSUME_RETRIES) {
            continue;
          }
          throw error;
        }
        if (hasPrismaErrorCode(error, 'P2002')) {
          throw activeAgentConflict();
        }
        throw error;
      }
    }

    throw new Error('Enrollment transaction retry budget exhausted');
  }

  async revokeAgent(
    organizationId: string,
    vmId: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const agent = await transaction.agent.findFirst({
        where: { organizationId, vmId },
        select: { id: true, status: true },
      });
      if (!agent) {
        throw prismaNotFoundError('Agent not found');
      }
      if (agent.status !== AgentStatus.ACTIVE) {
        return;
      }

      await transaction.agent.updateMany({
        where: {
          id: agent.id,
          organizationId,
          vmId,
          status: AgentStatus.ACTIVE,
        },
        data: {
          status: AgentStatus.REVOKED,
          revokedAt: now,
        },
      });
    });
  }
}

export type EnrollmentTokenReuse = {
  read: (current: {
    tokenId: string;
    expiresAt: Date;
  }) => Promise<({ tokenId: string; expiresAt: Date } & TokenSeed) | null>;
  write: (issued: { tokenId: string; expiresAt: Date }) => Promise<void>;
};

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CONSUME_RETRIES = 3;

type EnrollmentTokenLockRow = {
  id: string;
  organizationId: string;
  vmId: string;
  status: EnrollmentTokenStatus;
  expiresAt: Date;
};

function activeAgentConflict(): ApplicationConflictError {
  return new ApplicationConflictError(
    'AGENT_ALREADY_ENROLLED',
    'Agent is already enrolled',
  );
}

function prismaNotFoundError(
  message: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2025',
    clientVersion: Prisma.prismaVersion.client,
  });
}
