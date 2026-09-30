import { Injectable } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';

export const ORGANIZATION_SELECT = {
  id: true,
  name: true,
  slug: true,
} as const satisfies Prisma.OrganizationSelect;

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
}

export interface OrganizationWithRole extends OrganizationSummary {
  role: Role;
}

export interface OrganizationUpdateInput {
  name?: string;
  slug?: string;
}

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findForUser(userId: string): Promise<OrganizationWithRole[]> {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: {
        role: true,
        organization: { select: ORGANIZATION_SELECT },
      },
    });

    return memberships.map(({ role, organization }) => ({
      ...organization,
      role,
    }));
  }

  getById(organizationId: string): Promise<OrganizationSummary | null> {
    return this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: ORGANIZATION_SELECT,
    });
  }

  update(
    organizationId: string,
    input: OrganizationUpdateInput,
  ): Promise<OrganizationSummary> {
    const data: Prisma.OrganizationUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name;
    }
    if (input.slug !== undefined) {
      data.slug = input.slug;
    }

    return this.prisma.organization.update({
      where: { id: organizationId },
      data,
      select: ORGANIZATION_SELECT,
    });
  }
}
