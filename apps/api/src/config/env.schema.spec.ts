import { describe, expect, it } from 'vitest';
import { envSchema } from './env.schema.js';

const validEnvironment = {
  NODE_ENV: 'development',
  PORT: '3000',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:password@host/db?sslmode=require',
  REDIS_URL: 'redis://default:password@localhost:6379',
  COGNITO_REGION: 'ap-southeast-1',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_example',
  COGNITO_CLIENT_ID: 'exampleclientid',
} as const;

type EnvironmentKey = keyof typeof validEnvironment;

function validEnvWithout(key: EnvironmentKey) {
  const environment = { ...validEnvironment };
  delete environment[key];
  return environment;
}

describe('envSchema', () => {
  it('accepts the local API configuration and transforms PORT to a number', () => {
    const parsed = envSchema.parse(validEnvironment);

    expect(parsed).toMatchObject({
      ...validEnvironment,
      PORT: 3000,
    });
    expect(parsed.COGNITO_CLIENT_SECRET).toBeUndefined();
  });

  it('accepts an optional Cognito client secret when provided', () => {
    const parsed = envSchema.parse({
      ...validEnvironment,
      COGNITO_CLIENT_SECRET: 'client-secret',
    });

    expect(parsed.COGNITO_CLIENT_SECRET).toBe('client-secret');
  });

  it('rejects missing required environment values', () => {
    expect(() => envSchema.parse(validEnvWithout('REDIS_URL'))).toThrow();
    expect(() => envSchema.parse(validEnvWithout('DATABASE_URL'))).toThrow();
    expect(() =>
      envSchema.parse(validEnvWithout('COGNITO_CLIENT_ID')),
    ).toThrow();
  });

  it('rejects unsupported environments and invalid ports', () => {
    expect(() =>
      envSchema.parse({ ...validEnvironment, NODE_ENV: 'staging' }),
    ).toThrow();
    expect(() =>
      envSchema.parse({ ...validEnvironment, PORT: 'not-a-number' }),
    ).toThrow();
    expect(() =>
      envSchema.parse({ ...validEnvironment, PORT: '70000' }),
    ).toThrow();
  });

  it.each([
    ['WEB_URL', { WEB_URL: 'localhost:5173' }],
    ['DATABASE_URL', { DATABASE_URL: 'not-a-url' }],
    ['REDIS_URL', { REDIS_URL: 'not-a-url' }],
  ] as const)('rejects an invalid %s URL', (_name, override) => {
    expect(() =>
      envSchema.parse({ ...validEnvironment, ...override }),
    ).toThrow();
  });

  it('rejects invalid Cognito identifiers', () => {
    expect(() =>
      envSchema.parse({ ...validEnvironment, COGNITO_REGION: 'not-a-region' }),
    ).toThrow();
    expect(() =>
      envSchema.parse({
        ...validEnvironment,
        COGNITO_USER_POOL_ID: 'invalid-pool-id',
      }),
    ).toThrow();
    expect(() =>
      envSchema.parse({
        ...validEnvironment,
        COGNITO_USER_POOL_ID: 'us-east-1_example',
      }),
    ).toThrow();
    expect(() =>
      envSchema.parse({ ...validEnvironment, COGNITO_CLIENT_ID: '' }),
    ).toThrow();
  });

  it('rejects unknown environment keys', () => {
    expect(() =>
      envSchema.parse({ ...validEnvironment, UNKNOWN_SETTING: 'unexpected' }),
    ).toThrow();
  });
});
