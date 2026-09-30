import { describe, expect, it } from 'vitest';
import {
  confirmRegistrationSchema,
  registerSchema,
  resendConfirmationSchema,
} from './registration.schema.js';

describe('registration schemas', () => {
  it('accepts a Cognito-compatible registration payload', () => {
    expect(
      registerSchema.parse({
        email: 'person@example.com',
        displayName: 'Person',
        password: 'Correct-Horse-123',
        confirmPassword: 'Correct-Horse-123',
      }),
    ).toEqual({
      email: 'person@example.com',
      displayName: 'Person',
      password: 'Correct-Horse-123',
      confirmPassword: 'Correct-Horse-123',
    });
  });

  it('rejects passwords that do not meet the Cognito policy or match', () => {
    const result = registerSchema.safeParse({
      email: 'person@example.com',
      displayName: 'Person',
      password: 'short',
      confirmPassword: 'different',
    });

    expect(result.success).toBe(false);
  });

  it('accepts confirmation and resend payloads', () => {
    expect(
      confirmRegistrationSchema.parse({
        email: 'person@example.com',
        confirmationCode: '123456',
      }),
    ).toEqual({
      email: 'person@example.com',
      confirmationCode: '123456',
    });
    expect(
      resendConfirmationSchema.parse({
        email: 'person@example.com',
      }),
    ).toEqual({ email: 'person@example.com' });
  });
});
