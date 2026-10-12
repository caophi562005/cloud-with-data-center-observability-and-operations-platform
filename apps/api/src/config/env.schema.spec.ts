import { describe, expect, it } from 'vitest';
import { envSchema, parseEnv } from './env.schema.js';

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
  it.each([
    { VM_DISCONNECTED_AFTER_SECONDS: '0' },
    { VM_DISCONNECTED_AFTER_SECONDS: 'Infinity' },
    { VM_DISCONNECTED_AFTER_SECONDS: '301.5' },
    { VM_HEALTH_CPU_WARNING_PERCENT: '-1' },
    { VM_HEALTH_MEMORY_WARNING_PERCENT: '101' },
    { VM_HEALTH_DISK_WARNING_PERCENT: 'NaN' },
    { VM_HEALTH_CRITICAL_PERCENT: '80' },
    { VM_HEALTH_CRITICAL_PERCENT: '85', VM_HEALTH_CPU_WARNING_PERCENT: '90' },
  ])('rejects invalid or inverted health policy %o', (override) => {
    expect(() => parseEnv({ ...validEnvironment, ...override })).toThrow();
  });
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

  it('accepts only a 32-byte hex enrollment cache key when configured', () => {
    expect(
      envSchema.parse({
        ...validEnvironment,
        ENROLLMENT_TOKEN_CACHE_KEY: 'ab'.repeat(32),
      }).ENROLLMENT_TOKEN_CACHE_KEY,
    ).toBe('ab'.repeat(32));
    for (const key of ['', 'short', 'z'.repeat(64), 'a'.repeat(62)]) {
      expect(() =>
        envSchema.parse({
          ...validEnvironment,
          ENROLLMENT_TOKEN_CACHE_KEY: key,
        }),
      ).toThrow();
    }
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

  it('loads the canonical metrics query keys without accepting write credentials', () => {
    const parsed = parseEnv({
      ...validEnvironment,
      METRICS_QUERY_URL: 'https://metrics.example/api/prom',
      METRICS_USERNAME: 'tenant',
      METRICS_QUERY_TOKEN: 'read-scoped-token',
      METRICS_WRITE_URL: 'https://metrics.example/api/prom/push',
      METRICS_WRITE_TOKEN: 'write-scoped-token',
    });

    expect(parsed).toMatchObject({
      METRICS_QUERY_URL: 'https://metrics.example/api/prom',
      METRICS_USERNAME: 'tenant',
      METRICS_QUERY_TOKEN: 'read-scoped-token',
    });
    expect(parsed).not.toHaveProperty('METRICS_WRITE_URL');
    expect(parsed).not.toHaveProperty('METRICS_WRITE_TOKEN');
  });

  it.each([
    'METRICS_QUERY_URL',
    'METRICS_USERNAME',
    'METRICS_QUERY_TOKEN',
  ] as const)('rejects query configuration missing %s', (missingKey) => {
    const metrics: Record<string, string> = {
      METRICS_QUERY_URL: 'https://metrics.example/api/prom',
      METRICS_USERNAME: 'tenant',
      METRICS_QUERY_TOKEN: 'read-scoped-token',
    };
    delete metrics[missingKey];
    const result = envSchema.safeParse({ ...validEnvironment, ...metrics });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((issue) => issue.path[0] === missingKey),
      ).toBe(true);
    }
  });

  it.each([
    'not-a-url',
    'ftp://metrics.example/api/prom',
    'http://metrics.example/api/prom',
    'https://user:secret@metrics.example/api/prom',
    'https://metrics.example/api/prom?token=secret',
    'https://metrics.example/api/prom#fragment',
  ])('rejects unsafe metrics query URL %s', (url) => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        METRICS_QUERY_URL: url,
        METRICS_USERNAME: 'tenant',
        METRICS_QUERY_TOKEN: 'read-scoped-token',
      }).success,
    ).toBe(false);
  });

  it.each([
    'http://localhost:9090',
    'http://127.0.0.1:9090',
    'http://[::1]:9090',
  ])('allows loopback HTTP for local query tests: %s', (url) => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        METRICS_QUERY_URL: url,
        METRICS_USERNAME: 'tenant',
        METRICS_QUERY_TOKEN: 'read-scoped-token',
      }).success,
    ).toBe(true);
  });

  it.each([
    { METRICS_USERNAME: '' },
    { METRICS_USERNAME: '   ' },
    { METRICS_USERNAME: 'tenant:extra' },
    { METRICS_USERNAME: 'tenant\nextra' },
    { METRICS_QUERY_TOKEN: '' },
    { METRICS_QUERY_TOKEN: '   ' },
    { METRICS_QUERY_TOKEN: ' token ' },
    { METRICS_QUERY_TOKEN: 'token\nextra' },
  ])('rejects invalid metrics query credentials: %j', (override) => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        METRICS_QUERY_URL: 'https://metrics.example/api/prom',
        METRICS_USERNAME: 'tenant',
        METRICS_QUERY_TOKEN: 'read-scoped-token',
        ...override,
      }).success,
    ).toBe(false);
  });

  it.each([
    [undefined, 'basic'],
    ['', 'basic'],
    ['   ', 'basic'],
    [' BaSiC ', 'basic'],
    [' BeArEr ', 'bearer'],
    [' NoNe ', 'none'],
  ] as const)(
    'accepts query auth modes without write fallback: %s',
    (mode, expected) => {
      const parsed = parseEnv({
        ...validEnvironment,
        METRICS_QUERY_URL: 'https://metrics.example/api/prom',
        METRICS_QUERY_AUTH_MODE: mode,
        METRICS_USERNAME: ' tenant ',
        METRICS_QUERY_TOKEN: 'synthetic-read-token',
        METRICS_WRITE_AUTH_MODE: 'unsupported-write-mode',
        METRICS_WRITE_TOKEN: 'synthetic-write-token',
      });
      expect(parsed).toMatchObject({
        METRICS_QUERY_AUTH_MODE: expected,
        METRICS_QUERY_TOKEN: 'synthetic-read-token',
      });
      expect(parsed).not.toHaveProperty('METRICS_WRITE_AUTH_MODE');
      expect(parsed).not.toHaveProperty('METRICS_WRITE_TOKEN');
    },
  );

  it.each([
    { METRICS_QUERY_AUTH_MODE: 'none' },
    { METRICS_QUERY_AUTH_MODE: 'bearer' },
    { METRICS_QUERY_AUTH_MODE: 'basic' },
    { METRICS_QUERY_AUTH_MODE: 'unknown' },
    {
      METRICS_QUERY_URL: 'https://metrics.example',
      METRICS_QUERY_AUTH_MODE: 'unknown',
    },
    {
      METRICS_QUERY_URL: 'https://metrics.example',
      METRICS_QUERY_AUTH_MODE: 'bearer',
    },
    {
      METRICS_QUERY_URL: 'https://metrics.example',
      METRICS_QUERY_AUTH_MODE: 'basic',
      METRICS_QUERY_TOKEN: 'synthetic-read-token',
    },
    {
      METRICS_QUERY_URL: 'https://metrics.example',
      METRICS_QUERY_AUTH_MODE: 'basic',
      METRICS_USERNAME: 'tenant',
    },
    { METRICS_USERNAME: 'tenant' },
    {
      METRICS_QUERY_URL: 'https://metrics.example',
      METRICS_USERNAME: 'tenant',
      METRICS_WRITE_TOKEN: 'synthetic-write-token',
    },
  ])('requires mode-specific query configuration: %o', (override) => {
    expect(() => parseEnv({ ...validEnvironment, ...override })).toThrow();
  });

  it.each([undefined, '', '   '])(
    'keeps wholly absent query configuration valid with mode %s',
    (mode) => {
      expect(
        parseEnv({ ...validEnvironment, METRICS_QUERY_AUTH_MODE: mode }),
      ).toMatchObject({ METRICS_QUERY_AUTH_MODE: 'basic' });
    },
  );

  it.each([
    ['none', 'unused:bad\u0000', 'unused\r\nsecret'],
    ['bearer', 'unused:bad\u0000', 'synthetic-read-token'],
  ])('ignores unused credentials for %s', (mode, username, token) => {
    expect(() =>
      parseEnv({
        ...validEnvironment,
        METRICS_QUERY_URL: 'https://metrics.example',
        METRICS_QUERY_AUTH_MODE: mode,
        METRICS_USERNAME: username,
        METRICS_QUERY_TOKEN: token,
      }),
    ).not.toThrow();
  });

  it.each([
    { METRICS_USERNAME: 'tenant\u0000extra' },
    { METRICS_USERNAME: '\ttenant' },
    { METRICS_USERNAME: 'tenant\u007fextra' },
    { METRICS_QUERY_TOKEN: 'token\u0000extra' },
    { METRICS_QUERY_TOKEN: 'token\textra' },
    { METRICS_QUERY_TOKEN: 'token\u007fextra' },
  ])('rejects Basic ASCII controls: %o', (override) => {
    expect(() =>
      parseEnv({
        ...validEnvironment,
        METRICS_QUERY_URL: 'https://metrics.example',
        METRICS_USERNAME: 'tenant',
        METRICS_QUERY_TOKEN: 'synthetic-read-token',
        ...override,
      }),
    ).toThrow();
  });

  it.each([
    '',
    '   ',
    ' token',
    'token ',
    'token extra',
    'token\textra',
    'token\r\nextra',
    'token\u0000extra',
    'token\u007fextra',
    'tokén',
  ])('rejects invalid used Bearer token %j', (token) => {
    expect(() =>
      parseEnv({
        ...validEnvironment,
        METRICS_QUERY_URL: 'https://metrics.example',
        METRICS_QUERY_AUTH_MODE: 'bearer',
        METRICS_USERNAME: 'tenant',
        METRICS_QUERY_TOKEN: token,
      }),
    ).toThrow();
  });

  it('keeps accepted Basic bytes except trimmed username and sanitizes credential errors', () => {
    expect(
      parseEnv({
        ...validEnvironment,
        METRICS_QUERY_URL: 'https://metrics.example',
        METRICS_USERNAME: ' ténant ',
        METRICS_QUERY_TOKEN: 'token with internal spaces',
      }),
    ).toMatchObject({
      METRICS_USERNAME: 'ténant',
      METRICS_QUERY_TOKEN: 'token with internal spaces',
    });
    const result = envSchema.safeParse({
      ...validEnvironment,
      METRICS_QUERY_URL: 'https://metrics.example',
      METRICS_USERNAME: 'synthetic:private-username',
      METRICS_QUERY_TOKEN: 'synthetic\u0000private-token',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).not.toContain('synthetic');
    }
  });

  it.each([
    ['https://metrics.example/api/prom', true],
    ['http://localhost:9090', true],
    ['http://127.0.0.1:9090', true],
    ['http://127.10.20.30:9090', true],
    ['http://[::1]:9090', true],
    ['http://prometheus:9090', false],
    ['https://user:secret@metrics.example/api/prom', false],
    ['https://metrics.example/api/prom?query=x', false],
    ['https://metrics.example/api/prom?', false],
    ['https://metrics.example/api/prom#fragment', false],
    ['https://metrics.example/api/prom#', false],
  ] as const)('preserves loopback URL policy: %s', (url, accepted) => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        METRICS_QUERY_URL: url,
        METRICS_USERNAME: 'tenant',
        METRICS_QUERY_TOKEN: 'synthetic-read-token',
      }).success,
    ).toBe(accepted);
  });

  it('rejects unknown environment keys', () => {
    expect(() =>
      envSchema.parse({ ...validEnvironment, UNKNOWN_SETTING: 'unexpected' }),
    ).toThrow();
  });
});
