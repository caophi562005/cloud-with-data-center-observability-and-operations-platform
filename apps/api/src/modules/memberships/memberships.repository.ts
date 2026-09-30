import { Injectable } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';

export const MEMBER_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
} as const satisfies Prisma.UserSelect;

export const MEMBERSHIP_SELECT = {
  id: true,
  userId: true,
  role: true,
  user: { select: MEMBER_USER_SELECT },
} as const satisfies Prisma.MembershipSelect;

export const MEMBERSHIP_CONTEXT_SELECT = {
  id: true,
  userId: true,
  organizationId: true,
  role: true,
} as const satisfies Prisma.MembershipSelect;

export interface MembershipRecord {
  id: string;
  userId: string;
  organizationId: string;
  role: Role;
}

export interface MemberSummary {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
}

export interface MembershipCreateInput {
  userId: string;
  role: Role;
}

function toMemberSummary(member: {
  id: string;
  userId: string;
  role: Role;
  user: {
    id: string;
    email: string;
    displayName: string | null;
  };
}): MemberSummary {
  return {
    id: member.id,
    userId: member.userId,
    email: member.user.email,
    displayName: member.user.displayName,
    role: member.role,
  };
}

@Injectable()
export class MembershipsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByUserAndOrganization(
    userId: string,
    organizationId: string,
  ): Promise<MembershipRecord | null> {
    return this.prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
      select: MEMBERSHIP_CONTEXT_SELECT,
    });
  }

  async list(organizationId: string): Promise<MemberSummary[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId },
      select: MEMBERSHIP_SELECT,
    });

    return memberships.map(toMemberSummary);
  }

  async create(
    organizationId: string,
    input: MembershipCreateInput,
  ): Promise<MemberSummary> {
    const data: Prisma.MembershipCreateInput = {
      organization: { connect: { id: organizationId } },
      user: { connect: { id: input.userId } },
      role: input.role,
    };

    const membership = await this.prisma.membership.create({
      data,
      select: MEMBERSHIP_SELECT,
    });
    return toMemberSummary(membership);
  }

  async updateRole(
    organizationId: string,
    userId: string,
    role: Role,
  ): Promise<MemberSummary> {
    const membership = await this.prisma.membership.update({
      where: {
        userId_organizationId: { userId, organizationId },
      },
      data: { role },
      select: MEMBERSHIP_SELECT,
    });
    return toMemberSummary(membership);
  }

  async remove(organizationId: string, userId: string): Promise<void> {
    await this.prisma.membership.delete({
      where: {
        userId_organizationId: { userId, organizationId },
      },
    });
  }
}
