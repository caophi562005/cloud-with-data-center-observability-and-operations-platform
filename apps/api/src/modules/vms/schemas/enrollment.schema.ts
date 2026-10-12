import { z } from 'zod';

export const enrollmentSchema = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^ENR_[A-Za-z0-9_-]{43}$/),
    os: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

// The transport schema keeps token content bounded while allowing malformed
// values to reach the service's generic invalid-token response path. The
// canonical enrollmentSchema remains strict for generated-token contracts.
export const enrollmentTransportSchema = z
  .object({
    token: z.string().trim().min(1).max(256),
    os: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export type EnrollmentInput = z.infer<typeof enrollmentSchema>;
