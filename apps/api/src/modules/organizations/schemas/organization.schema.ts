import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(200);

export const organizationParamsSchema = z
  .object({
    organizationId: identifierSchema,
  })
  .strict();

export const organizationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.slug !== undefined, {
    message: 'At least one organization field is required',
  });

export type OrganizationParams = z.infer<typeof organizationParamsSchema>;
export type OrganizationUpdate = z.infer<typeof organizationUpdateSchema>;
