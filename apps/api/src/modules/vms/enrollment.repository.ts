import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AgentCollectorType,
  AgentStatus,
  EnrollmentTokenScope,
  EnrollmentTokenStatus,
  Prisma,
} from '@prisma/client';
import {
  ApplicationConflictError,
  hasPrismaErrorCode,
} from '../../common/errors/application-conflict.error.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import {
  DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS,
  ORGANIZATION_INSTALL_CODE_TTL_SECONDS,
  type TokenSeed,
} from './vms.types.js';

import { initialMonitoringDefinition } from './monitoring/monitoring.types.js';
import {
  organizationEnrollmentMetadataSchema,
  telegrafEnrollmentMetadataSchema,
  type EnrollmentInput,
} from './schemas/enrollment.schema.js';

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

  async issueOrganizationToken(
    organizationId: string,
    tokenHash: string,
    now: Date,
  ): Promise<{ id: string; expiresAt: Date }> {
    return this.prisma.enrollmentToken.create({
      data: {
        organizationId,
        scope: EnrollmentTokenScope.ORGANIZATION,
        status: EnrollmentTokenStatus.ACTIVE,
        vmId: null,
        tokenHash,
        expiresAt: new Date(
          now.getTime() + ORGANIZATION_INSTALL_CODE_TTL_SECONDS * 1000,
        ),
      },
      select: { id: true, expiresAt: true },
    });
  }

  async revokeOrganizationToken(
    organizationId: string,
    tokenId: string,
  ): Promise<void> {
    // Scoped update waits for a concurrent consume's row lock. Never revoke a
    // VM recovery token or mutate a consumed code, even when its ID is known.
    const result = await this.prisma.enrollmentToken.updateMany({
      where: {
        id: tokenId,
        organizationId,
        scope: EnrollmentTokenScope.ORGANIZATION,
        status: EnrollmentTokenStatus.ACTIVE,
      },
      data: { status: EnrollmentTokenStatus.REVOKED, revokedAt: new Date() },
    });
    if (result.count === 0) {
      const token = await this.prisma.enrollmentToken.findFirst({
        where: {
          id: tokenId,
          organizationId,
          scope: EnrollmentTokenScope.ORGANIZATION,
        },
        select: { id: true },
      });
      if (!token) throw prismaNotFoundError('Install code not found');
    }
  }

  async consumeAndEnroll(
    input: Omit<EnrollmentInput, 'token'> & {
      tokenHash: string;
      credentialHash: string;
      now: Date;
    },
  ): Promise<{
    agentId: string;
    organizationId: string;
    vmId: string;
    desiredVersion: number;
  } | null> {
    if (!SHA256_HEX_PATTERN.test(input.tokenHash)) return null;

    for (let attempt = 0; attempt < MAX_CONSUME_RETRIES; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const tokenRows = await transaction.$queryRaw<
              EnrollmentTokenLockRow[]
            >(Prisma.sql`
            SELECT "id", "organizationId", "vmId", "scope", "status", "expiresAt"
            FROM "EnrollmentToken" WHERE "tokenHash" = ${input.tokenHash} FOR UPDATE
          `);
            const token = tokenRows[0];
            // Evaluate fresh time only AFTER acquiring the lock, including retries.
            if (
              !token ||
              token.status !== EnrollmentTokenStatus.ACTIVE ||
              token.expiresAt <= new Date()
            ) {
              return null;
            }

            const bootstrap = token.scope === EnrollmentTokenScope.ORGANIZATION;
            if (
              (bootstrap && token.vmId !== null) ||
              (!bootstrap &&
                (token.scope !== EnrollmentTokenScope.VM || !token.vmId))
            ) {
              return null;
            }
            const telegraf = input.collectorType === 'TELEGRAF';
            if (bootstrap || telegraf) {
              const metadata = (
                bootstrap
                  ? organizationEnrollmentMetadataSchema
                  : telegrafEnrollmentMetadataSchema
              ).safeParse(input);
              if (!metadata.success)
                throw new BadRequestException('Invalid collector metadata');
            } else if (
              input.collectorVersion !== undefined ||
              input.buildId !== undefined
            ) {
              throw new BadRequestException('Collector type is required');
            }

            let vmId: string;
            if (bootstrap) {
              // The unique organization/hostname constraint rejects both active and
              // revoked hosts. No lookup/attach/re-key fallback is permitted here.
              try {
                const vm = await transaction.vm.create({
                  data: {
                    organizationId: token.organizationId,
                    hostname: input.hostname!,
                    os: input.os!,
                  },
                  select: { id: true },
                });
                vmId = vm.id;
              } catch (error) {
                if (hasPrismaErrorCode(error, 'P2002')) {
                  throw new ApplicationConflictError(
                    'VM_HOSTNAME_CONFLICT',
                    'Hostname is already registered',
                  );
                }
                throw error;
              }
            } else {
              vmId = token.vmId!;
              const lockedVm = await transaction.$queryRaw<
                { id: string }[]
              >(Prisma.sql`
              SELECT "id" FROM "Vm" WHERE "id" = ${vmId}
                AND "organizationId" = ${token.organizationId} FOR UPDATE
            `);
              // A VM lock may itself take time; don't consume an expired token.
              if (lockedVm.length === 0 || token.expiresAt <= new Date())
                return null;
            }

            const existingAgent = bootstrap
              ? null
              : await transaction.agent.findFirst({
                  where: { organizationId: token.organizationId, vmId },
                  select: { id: true, status: true, collectorType: true },
                });
            if (existingAgent?.status === AgentStatus.ACTIVE)
              throw activeAgentConflict();
            if (
              existingAgent?.collectorType === AgentCollectorType.TELEGRAF &&
              !telegraf
            ) {
              throw new BadRequestException(
                'Telegraf recovery requires collector metadata',
              );
            }

            const now = new Date();
            const agentData = {
              credentialHash: input.credentialHash,
              status: AgentStatus.ACTIVE,
              enrolledAt: now,
              revokedAt: null,
              ...(telegraf
                ? {
                    collectorType: AgentCollectorType.TELEGRAF,
                    collectorVersion: input.collectorVersion,
                    buildId: input.buildId,
                    appliedConfigVersion: null,
                    appliedConfigHash: null,
                    appliedConfigAt: null,
                    rejectedConfigVersion: null,
                    rejectedConfigError: null,
                    lastControlContactAt: null,
                  }
                : {}),
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
                    vmId,
                    ...agentData,
                  },
                  select: { id: true },
                });

            if (!bootstrap && input.os !== undefined) {
              await transaction.vm.update({
                where: { id: vmId },
                data: { os: input.os },
              });
            }
            // Only an explicit Telegraf enrollment/recovery initializes the native
            // profile. Existing desired settings are retained during recovery.
            const definition = initialMonitoringDefinition();
            const config = telegraf
              ? await transaction.vmMonitoringConfig.upsert({
                  where: { vmId },
                  create: {
                    vmId,
                    organizationId: token.organizationId,
                    version: 1,
                    schemaVersion: definition.schemaVersion,
                    profileKey: definition.profileKey,
                    definition: { ...definition },
                  },
                  update: {},
                  select: { version: true },
                })
              : null;

            await transaction.enrollmentToken.update({
              where: { id: token.id },
              data: { status: EnrollmentTokenStatus.CONSUMED, consumedAt: now },
            });
            return {
              agentId: agent.id,
              organizationId: token.organizationId,
              vmId,
              desiredVersion: config?.version ?? 0,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          hasPrismaErrorCode(error, 'P2034') &&
          attempt + 1 < MAX_CONSUME_RETRIES
        )
          continue;
        if (hasPrismaErrorCode(error, 'P2002')) throw activeAgentConflict();
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
  vmId: string | null;
  scope: EnrollmentTokenScope;
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
