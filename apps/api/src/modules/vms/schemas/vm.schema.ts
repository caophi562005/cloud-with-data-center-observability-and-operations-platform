import { isIP } from 'node:net';
import { z } from 'zod';

const uuidSchema = z.string().uuid();

const hostnameSchema = z.string().trim().toLowerCase().min(1).max(253);

const ipAddressSchema = z
  .string()
  .trim()
  .max(45)
  .refine((value) => isIP(value) !== 0, {
    message: 'Invalid IP address',
  });

export const vmOrganizationParamsSchema = z
  .object({
    organizationId: uuidSchema,
  })
  .strict();

export const vmParamsSchema = z
  .object({
    organizationId: uuidSchema,
    vmId: uuidSchema,
  })
  .strict();

export const vmTagParamsSchema = vmParamsSchema
  .extend({
    tagId: uuidSchema,
  })
  .strict();

export const vmCreateSchema = z
  .object({
    hostname: hostnameSchema,
    ipAddress: ipAddressSchema.optional(),
  })
  .strict();

export const vmUpdateSchema = z
  .object({
    hostname: hostnameSchema.optional(),
    ipAddress: ipAddressSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.hostname !== undefined || value.ipAddress !== undefined,
    { message: 'At least one VM field must be provided' },
  );

export const vmTagSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9_.-]+$/),
    value: z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(128)
      .refine((value) => !value.includes(':'), {
        message: 'Tag value must not contain a colon',
      }),
  })
  .strict();

const vmTagFilterSchema = z.string().transform((value, context) => {
  const separatorIndex = value.indexOf(':');
  if (
    separatorIndex <= 0 ||
    separatorIndex !== value.lastIndexOf(':') ||
    separatorIndex === value.length - 1
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Tag filter must contain one key:value separator',
    });
    return z.NEVER;
  }

  const parsed = vmTagSchema.safeParse({
    key: value.slice(0, separatorIndex),
    value: value.slice(separatorIndex + 1),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: 'custom', message: issue.message });
    }
    return z.NEVER;
  }

  return `${parsed.data.key}:${parsed.data.value}`;
});

const vmTagFilterInputSchema = z
  .union([vmTagFilterSchema, z.array(vmTagFilterSchema)])
  .superRefine((tags, context) => {
    const normalizedTags = Array.isArray(tags) ? tags : [tags];
    if (new Set(normalizedTags).size !== normalizedTags.length) {
      context.addIssue({
        code: 'custom',
        message: 'Tag filters must be unique',
      });
    }
  })
  .transform((tags) => (Array.isArray(tags) ? tags : [tags]));

export const vmListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    tag: vmTagFilterInputSchema.optional(),
  })
  .strict();

export type VmOrganizationParams = z.infer<typeof vmOrganizationParamsSchema>;
export type VmParams = z.infer<typeof vmParamsSchema>;
export type VmTagParams = z.infer<typeof vmTagParamsSchema>;
export type VmCreateInput = z.infer<typeof vmCreateSchema>;
export type VmUpdateInput = z.infer<typeof vmUpdateSchema>;
export type VmTagInput = z.infer<typeof vmTagSchema>;
export type VmListQuery = z.infer<typeof vmListQuerySchema>;
