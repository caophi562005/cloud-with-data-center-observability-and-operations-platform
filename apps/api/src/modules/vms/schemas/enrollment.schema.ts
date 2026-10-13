import { z } from 'zod';

const enrollmentMetadata = {
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/)
    .optional(),
  // Preserve the legacy VM-bound OS field. Telegraf validates supported OS below.
  os: z.string().trim().min(1).max(128).optional(),
  collectorType: z.literal('TELEGRAF').optional(),
  collectorVersion: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
    .optional(),
  buildId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
    .optional(),
};

export const enrollmentSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^ENR_[A-Za-z0-9_-]{43}$/),
    ...enrollmentMetadata,
  })
  .strict();

// Only relax token syntax, never metadata or spoofed identity fields. Malformed
// tokens still reach the service's uniform invalid-token response path.
export const enrollmentTransportSchema = z
  .object({
    token: z.string().trim().min(1).max(256),
    ...enrollmentMetadata,
  })
  .strict();

export const telegrafEnrollmentMetadataSchema = z.object({
  hostname: enrollmentMetadata.hostname,
  os: z.enum(['linux', 'windows']),
  collectorType: z.literal('TELEGRAF'),
  collectorVersion: enrollmentMetadata.collectorVersion.unwrap(),
  buildId: enrollmentMetadata.buildId.unwrap(),
});

export const organizationEnrollmentMetadataSchema =
  telegrafEnrollmentMetadataSchema.extend({
    hostname: enrollmentMetadata.hostname.unwrap(),
  });

export const installCodeParamsSchema = z
  .object({
    organizationId: z.string().uuid(),
    tokenId: z.string().uuid(),
  })
  .strict();

export type EnrollmentInput = z.infer<typeof enrollmentSchema>;
