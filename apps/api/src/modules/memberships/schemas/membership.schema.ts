import { Role } from '@prisma/client';
import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(200);

export const membershipParamsSchema = z
  .object({
    organizationId: identifierSchema,
    userId: identifierSchema,
  })
  .strict();

export const membershipOrganizationParamsSchema = z
  .object({
    organizationId: identifierSchema,
  })
  .strict();

export const membershipCreateSchema = z
  .object({
    userId: identifierSchema,
    role: z.enum([Role.ADMIN, Role.OPERATOR, Role.VIEWER]),
  })
  .strict();

export const membershipRoleSchema = z
  .object({
    role: z.enum([Role.ADMIN, Role.OPERATOR, Role.VIEWER]),
  })
  .strict();

export type MembershipParams = z.infer<typeof membershipParamsSchema>;
export type MembershipOrganizationParams = z.infer<
  typeof membershipOrganizationParamsSchema
>;
export type MembershipCreate = z.infer<typeof membershipCreateSchema>;
export type MembershipRoleUpdate = z.infer<typeof membershipRoleSchema>;
