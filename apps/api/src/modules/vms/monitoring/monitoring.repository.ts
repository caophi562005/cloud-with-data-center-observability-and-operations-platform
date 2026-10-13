import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AgentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/database/prisma/prisma.service.js';
import type { AgentIdentity, MonitoringDefinition } from './monitoring.types.js';

const agentSelect = {
  id: true, organizationId: true, vmId: true, status: true,
  collectorType: true, collectorVersion: true, buildId: true,
  appliedConfigVersion: true, appliedConfigHash: true, appliedConfigAt: true,
  rejectedConfigVersion: true, rejectedConfigError: true, lastControlContactAt: true,
} as const satisfies Prisma.AgentSelect;
const vmSelect = {
  id: true, organizationId: true, os: true,
  agent: { select: agentSelect }, monitoringConfig: true,
} as const satisfies Prisma.VmSelect;
export type MonitoringSnapshot = Prisma.VmGetPayload<{ select: typeof vmSelect }>;

@Injectable()
export class MonitoringRepository {
  constructor(private readonly prisma: PrismaService) {}

  // A single lock order (VM then Agent) also matches explicit enrollment recovery.
  // Keeping the snapshot/read-render-write in this bounded transaction prevents
  // a save racing an ACK, or an old snapshot being ACKed after a newer save.
  async withLockedVm<T>(
    organizationId: string,
    vmId: string,
    operation: (snapshot: MonitoringSnapshot, transaction: Prisma.TransactionClient) => Promise<T>,
    identity?: AgentIdentity,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      const vm = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "Vm" WHERE "id" = ${vmId}::uuid
          AND "organizationId" = ${organizationId}::uuid FOR UPDATE
      `);
      if (!vm.length) {
        if (identity) throw new UnauthorizedException();
        throw new NotFoundException('VM not found');
      }
      // Guard authentication precedes the transaction: recheck DB authority under
      // lock so a concurrent revoke cannot be followed by an off-authority write.
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id" FROM "Agent" WHERE "vmId" = ${vmId}::uuid
          AND "organizationId" = ${organizationId}::uuid FOR UPDATE
      `);
      const snapshot = await transaction.vm.findUnique({
        where: { id: vmId, organizationId }, select: vmSelect,
      });
      if (!snapshot) throw new NotFoundException('VM not found');
      if (snapshot.agent && snapshot.agent.organizationId !== organizationId) throw new NotFoundException();
      if (snapshot.monitoringConfig && snapshot.monitoringConfig.organizationId !== organizationId) throw new NotFoundException();
      if (identity && (!snapshot.agent || snapshot.agent.id !== identity.agentId ||
        snapshot.agent.vmId !== identity.vmId || snapshot.agent.status !== AgentStatus.ACTIVE)) {
        throw new UnauthorizedException();
      }
      return operation(snapshot, transaction);
    }, { maxWait: 5_000, timeout: 5_000 });
  }

  async saveConfig(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    vmId: string,
    expectedVersion: number,
    definition: MonitoringDefinition,
    secretsCiphertext: string | null,
  ): Promise<void> {
    const updated = await transaction.vmMonitoringConfig.updateMany({
      where: { vmId, organizationId, version: expectedVersion },
      data: {
        version: { increment: 1 }, schemaVersion: definition.schemaVersion,
        profileKey: definition.profileKey,
        definition: definition as unknown as Prisma.InputJsonValue,
        secretsCiphertext,
      },
    });
    if (updated.count !== 1) throw new ConflictException('Monitoring configuration changed');
  }

  async updateAgent(
    transaction: Prisma.TransactionClient,
    identity: AgentIdentity,
    data: Prisma.AgentUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await transaction.agent.updateMany({
      where: {
        id: identity.agentId, vmId: identity.vmId, organizationId: identity.organizationId,
        status: AgentStatus.ACTIVE, vm: { id: identity.vmId, organizationId: identity.organizationId },
      },
      data,
    });
    if (updated.count !== 1) throw new UnauthorizedException();
  }
}
