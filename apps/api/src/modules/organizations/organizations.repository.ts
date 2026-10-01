import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { hasPrismaErrorCode } from '../../common/errors/application-conflict.error.js';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';

export const ORGANIZATION_SELECT = {
  id: true,
  name: true,
  slug: true,
} as const satisfies Prisma.OrganizationSelect;

const PERSONAL_ORGANIZATION_MAX_ATTEMPTS = 5;
const PERSONAL_ORGANIZATION_SLUG_FALLBACK = 'personal';
const PERSONAL_ORGANIZATION_SUFFIX_LENGTH = 6;
const SLUG_SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

  async provisionPersonalOrganization(
    userId: string,
    verifiedEmail: string,
  ): Promise<void> {
    const localPart = getEmailLocalPart(verifiedEmail);
    const name = localPart;
    const slugBase = normalizeSlugBase(localPart);

    for (
      let attempt = 0;
      attempt < PERSONAL_ORGANIZATION_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const slug = `${slugBase}-${createRandomSlugSuffix()}`;

      try {
        await this.prisma.$transaction(
          async (transaction) => {
            const existingMembership = await transaction.membership.findFirst({
              where: { userId },
              select: { id: true },
            });
            if (existingMembership) {
              return;
            }

            const organization = await transaction.organization.create({
              data: { name, slug },
            });
            await transaction.membership.create({
              data: {
                organization: { connect: { id: organization.id } },
                user: { connect: { id: userId } },
                role: Role.ADMIN,
              },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        return;
      } catch (error) {
        if (
          (hasPrismaErrorCode(error, 'P2002') ||
            hasPrismaErrorCode(error, 'P2034')) &&
          attempt < PERSONAL_ORGANIZATION_MAX_ATTEMPTS - 1
        ) {
          continue;
        }
        throw error;
      }
    }
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

function getEmailLocalPart(email: string): string {
  const atIndex = email.indexOf('@');
  return atIndex >= 0 ? email.slice(0, atIndex) : email;
}

function normalizeSlugBase(localPart: string): string {
  const normalized = localPart
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || PERSONAL_ORGANIZATION_SLUG_FALLBACK;
}

function createRandomSlugSuffix(): string {
  let suffix = '';
  for (let index = 0; index < PERSONAL_ORGANIZATION_SUFFIX_LENGTH; index += 1) {
    suffix += SLUG_SUFFIX_ALPHABET[randomInt(SLUG_SUFFIX_ALPHABET.length)];
  }
  return suffix;
}
