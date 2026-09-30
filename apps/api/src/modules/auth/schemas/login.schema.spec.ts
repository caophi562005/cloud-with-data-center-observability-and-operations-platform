import { describe, expect, it } from 'vitest';
import { loginSchema } from './login.schema.js';

describe('loginSchema', () => {
  it('accepts a valid email and non-empty password', () => {
    expect(
      loginSchema.parse({
        email: 'operator@example.com',
        password: 'correct horse',
      }),
    ).toEqual({ email: 'operator@example.com', password: 'correct horse' });
  });

  it('rejects malformed email, empty password, and unknown fields', () => {
    expect(() =>
      loginSchema.parse({ email: 'not-an-email', password: 'password' }),
    ).toThrow();
    expect(() =>
      loginSchema.parse({ email: 'operator@example.com', password: '' }),
    ).toThrow();
    expect(() =>
      loginSchema.parse({
        email: 'operator@example.com',
        password: 'password',
        token: 'secret',
      }),
    ).toThrow();
  });
});
