import { z } from 'zod';

const emailSchema = z.string().trim().email();
const passwordSchema = z
  .string()
  .min(12)
  .regex(/[a-z]/)
  .regex(/[A-Z]/)
  .regex(/[0-9]/);

export const registerSchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(100),
    password: passwordSchema,
    confirmPassword: z.string().min(1),
  })
  .strict()
  .refine((input) => input.password === input.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export const confirmRegistrationSchema = z
  .object({
    email: emailSchema,
    confirmationCode: z.string().trim().min(1).max(32),
  })
  .strict();

export const resendConfirmationSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type ConfirmRegistrationInput = z.infer<
  typeof confirmRegistrationSchema
>;
export type ResendConfirmationInput = z.infer<typeof resendConfirmationSchema>;
