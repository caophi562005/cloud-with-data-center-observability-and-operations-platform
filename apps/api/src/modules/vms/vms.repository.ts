import { Injectable } from '@nestjs/common';
import { EnrollmentTokenStatus, Prisma, VmStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import type {
  VmCreateInput,
  VmTagInput,
  VmUpdateInput,
} from './schemas/vm.schema.js';
import type {
  AgentSummary,
  TagFilter,
  TokenSeed,
  VmListFilters,
  VmPage,
  VmRecord,
  VmTagRecord,
} from './vms.types.js';

const VM_TAG_SELECT = {
  id: true,
  key: true,
  value: true,
} as const satisfies Prisma.TagSelect;

const VM_AGENT_SELECT = {
  id: true,
  organizationId: true,
  status: true,
  enrolledAt: true,
  lastSeenAt: true,
  collectorType: true,
  collectorVersion: true,
  buildId: true,
  lastControlContactAt: true,
} as const satisfies Prisma.AgentSelect;

const VM_BASE_SELECT = {
  id: true,
  organizationId: true,
  hostname: true,
  ipAddress: true,
  os: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  agent: { select: VM_AGENT_SELECT },
} as const satisfies Prisma.VmSelect;

export type { VmCreateInput, VmListFilters, VmUpdateInput };

export function createVmSelect(organizationId: string): Prisma.VmSelect {
  return {
    ...VM_BASE_SELECT,
    vmTags: {
      where: { organizationId, tag: { organizationId } },
      select: {
        organizationId: true,
        tag: { select: VM_TAG_SELECT },
      },
    },
  };
}

type VmProjection = {
  id: string;
  organizationId: string;
  hostname: string;
  ipAddress: string | null;
  os: string | null;
  status: VmRecord['status'];
  createdAt: Date;
  updatedAt: Date;
  vmTags?: Array<{
    organizationId: string;
    tag: VmTagRecord;
  }>;
  tags?: VmTagRecord[];
  agent:
    | {
        id: string;
        organizationId: string;
        status: AgentSummary['status'];
        enrolledAt: Date;
        lastSeenAt: Date | null;
        collectorType?: AgentSummary['collectorType'];
        collectorVersion?: string | null;
        buildId?: string | null;
        lastControlContactAt?: Date | null;
      }
    | AgentSummary
    | null;
};

function toVmRecord(value: VmProjection, organizationId: string): VmRecord {
  const relationTags = value.vmTags
    ? value.vmTags
        .filter((vmTag) => vmTag.organizationId === organizationId)
        .map((vmTag) => vmTag.tag)
    : (value.tags ?? []);
  const relationAgent = value.agent;
  const agent =
    relationAgent &&
    (!('organizationId' in relationAgent) ||
      relationAgent.organizationId === organizationId)
      ? {
          id: relationAgent.id,
          status: relationAgent.status,
          enrolledAt: relationAgent.enrolledAt,
          lastSeenAt: relationAgent.lastSeenAt,
          collectorType: relationAgent.collectorType ?? null,
          collectorVersion: relationAgent.collectorVersion ?? null,
          buildId: relationAgent.buildId ?? null,
          lastControlContactAt: relationAgent.lastControlContactAt ?? null,
        }
      : null;

  return {
    id: value.id,
    organizationId: value.organizationId,
    hostname: value.hostname,
    ipAddress: value.ipAddress,
    os: value.os,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    tags: relationTags,
    agent,
  };
}

function createWhere(
  organizationId: string,
  tags: TagFilter[],
): Prisma.VmWhereInput {
  const tagConditions = tags.map(({ key, value }) => ({
    vmTags: {
      some: {
        organizationId,
        tag: { organizationId, key, value },
      },
    },
  }));

  return {
    organizationId,
    ...(tagConditions.length > 0 ? { AND: tagConditions } : {}),
  };
}

function prismaNotFoundError(
  message: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2025',
    clientVersion: Prisma.prismaVersion.client,
  });
}

@Injectable()
export class VmsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createWithEnrollment(
    organizationId: string,
    input: VmCreateInput,
    seed: TokenSeed,
  ): Promise<{ vm: VmRecord; tokenId: string; expiresAt: Date }> {
    return this.prisma.$transaction(async (transaction) => {
      const data: Prisma.VmCreateInput = {
        organization: { connect: { id: organizationId } },
        hostname: input.hostname,
        status: VmStatus.DISCONNECTED,
        ...(input.ipAddress !== undefined
          ? { ipAddress: input.ipAddress }
          : {}),
      };
      const vm = await transaction.vm.create({
        data,
        select: createVmSelect(organizationId),
      });
      const token = await transaction.enrollmentToken.create({
        data: {
          organization: { connect: { id: organizationId } },
          vm: { connect: { id: vm.id } },
          tokenHash: seed.hash,
          status: EnrollmentTokenStatus.ACTIVE,
          expiresAt: seed.expiresAt,
        },
      });

      return {
        vm: toVmRecord(vm as unknown as VmProjection, organizationId),
        tokenId: token.id,
        expiresAt: seed.expiresAt,
      };
    });
  }

  async list(organizationId: string, filters: VmListFilters): Promise<VmPage> {
    const where = createWhere(organizationId, filters.tags);
    const [rows, total] = await Promise.all([
      this.prisma.vm.findMany({
        where,
        select: createVmSelect(organizationId),
        orderBy: { updatedAt: 'desc' },
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.vm.count({ where }),
    ]);

    return {
      items: rows.map((row) =>
        toVmRecord(row as unknown as VmProjection, organizationId),
      ),
      page: filters.page,
      pageSize: filters.pageSize,
      total,
    };
  }

  async getById(
    organizationId: string,
    vmId: string,
  ): Promise<VmRecord | null> {
    const vm = await this.prisma.vm.findUnique({
      where: { id: vmId, organizationId },
      select: createVmSelect(organizationId),
    });
    return vm
      ? toVmRecord(vm as unknown as VmProjection, organizationId)
      : null;
  }

  async update(
    organizationId: string,
    vmId: string,
    input: VmUpdateInput,
  ): Promise<VmRecord> {
    const data: Prisma.VmUpdateInput = {};
    if (input.hostname !== undefined) {
      data.hostname = input.hostname;
    }
    if (input.ipAddress !== undefined) {
      data.ipAddress = input.ipAddress;
    }

    const vm = await this.prisma.vm.update({
      where: { id: vmId, organizationId },
      data,
      select: createVmSelect(organizationId),
    });
    return toVmRecord(vm as unknown as VmProjection, organizationId);
  }

  async addTag(
    organizationId: string,
    vmId: string,
    input: VmTagInput,
  ): Promise<VmTagRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const vm = await transaction.vm.findUnique({
        where: { id: vmId, organizationId },
        select: { id: true },
      });
      if (!vm) {
        throw prismaNotFoundError('VM not found');
      }

      const tag = await transaction.tag.upsert({
        where: {
          organizationId_key_value: {
            organizationId,
            key: input.key,
            value: input.value,
          },
        },
        create: { organizationId, key: input.key, value: input.value },
        update: {},
        select: VM_TAG_SELECT,
      });
      const existingAssociation = await transaction.vmTag.findFirst({
        where: {
          organizationId,
          vmId,
          tagId: tag.id,
          tag: { organizationId },
          vm: { organizationId },
        },
        select: { tag: { select: VM_TAG_SELECT } },
      });
      if (existingAssociation) {
        return existingAssociation.tag;
      }

      const association = await transaction.vmTag.create({
        data: { organizationId, vmId, tagId: tag.id },
        select: { tag: { select: VM_TAG_SELECT } },
      });
      return association.tag;
    });
  }

  async updateTag(
    organizationId: string,
    vmId: string,
    tagId: string,
    input: VmTagInput,
  ): Promise<VmTagRecord> {
    return this.prisma.$transaction(async (transaction) => {
      const existingAssociation = await transaction.vmTag.findFirst({
        where: {
          organizationId,
          vmId,
          tagId,
          tag: { organizationId },
          vm: { organizationId },
        },
        select: { tag: { select: VM_TAG_SELECT } },
      });
      if (!existingAssociation) {
        throw prismaNotFoundError('VM tag not found');
      }
      if (
        existingAssociation.tag.key === input.key &&
        existingAssociation.tag.value === input.value
      ) {
        return existingAssociation.tag;
      }

      const replacementTag = await transaction.tag.upsert({
        where: {
          organizationId_key_value: {
            organizationId,
            key: input.key,
            value: input.value,
          },
        },
        create: { organizationId, key: input.key, value: input.value },
        update: {},
        select: VM_TAG_SELECT,
      });
      const replacementAssociation = await transaction.vmTag.findFirst({
        where: {
          organizationId,
          vmId,
          tagId: replacementTag.id,
          tag: { organizationId },
          vm: { organizationId },
        },
        select: { tag: { select: VM_TAG_SELECT } },
      });
      const removed = await transaction.vmTag.deleteMany({
        where: {
          organizationId,
          vmId,
          tagId,
          tag: { organizationId },
          vm: { organizationId },
        },
      });
      if (removed.count === 0) {
        throw prismaNotFoundError('VM tag not found');
      }
      if (replacementAssociation) {
        return replacementAssociation.tag;
      }

      const association = await transaction.vmTag.create({
        data: {
          organizationId,
          vmId,
          tagId: replacementTag.id,
        },
        select: { tag: { select: VM_TAG_SELECT } },
      });
      return association.tag;
    });
  }

  async removeTag(
    organizationId: string,
    vmId: string,
    tagId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const removed = await transaction.vmTag.deleteMany({
        where: {
          organizationId,
          vmId,
          tagId,
          tag: { organizationId },
          vm: { organizationId },
        },
      });
      if (removed.count === 0) {
        throw prismaNotFoundError('VM tag not found');
      }
    });
  }

  async remove(organizationId: string, vmId: string): Promise<void> {
    await this.prisma.vm.delete({ where: { id: vmId, organizationId } });
  }
}
