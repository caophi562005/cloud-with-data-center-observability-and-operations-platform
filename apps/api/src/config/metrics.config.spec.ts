import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, DEFAULT_VM_HEALTH_POLICY } from './env.schema.js';
import { createMetricsConfig, metricsConfig } from './metrics.config.js';

const baseEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  WEB_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://user:password@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  COGNITO_REGION: 'ap-southeast-1',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_example',
  COGNITO_CLIENT_ID: 'exampleclientid',
};

const queryEnvironment = {
  METRICS_QUERY_URL: 'https://metrics.example/api/prom/',
  METRICS_USERNAME: 'tenant',
  METRICS_QUERY_TOKEN: 'read-scoped-token',
};

const expectedQuery = {
  baseUrl: 'https://metrics.example/api/prom',
  auth: { mode: 'basic', username: 'tenant', token: 'read-scoped-token' },
};

afterEach(() => vi.unstubAllEnvs());

describe('metricsConfig', () => {
  it('loads validated operator health overrides independently of provider credentials', () => {
    const config = createMetricsConfig(
      parseEnv({
        ...baseEnvironment,
        VM_DISCONNECTED_AFTER_SECONDS: '120',
        VM_HEALTH_CPU_WARNING_PERCENT: '70',
        VM_HEALTH_MEMORY_WARNING_PERCENT: '75',
        VM_HEALTH_DISK_WARNING_PERCENT: '77',
        VM_HEALTH_CRITICAL_PERCENT: '90',
      }),
    );
    expect(config).toMatchObject({
      query: null,
      health: {
        staleSeconds: 120,
        cpuWarning: 70,
        memoryWarning: 75,
        diskWarning: 77,
        critical: 90,
      },
    });
  });
  it('keeps query disabled when metrics is not configured', () => {
    expect(createMetricsConfig(parseEnv(baseEnvironment))).toEqual({
      query: null,
      health: DEFAULT_VM_HEALTH_POLICY,
    });
  });

  it('loads a separate read token and normalizes trailing slashes', () => {
    const environment = parseEnv({
      ...baseEnvironment,
      ...queryEnvironment,
      METRICS_WRITE_TOKEN: 'not-the-read-token',
    });
    expect(createMetricsConfig(environment)).toEqual({
      query: expectedQuery,
      health: DEFAULT_VM_HEALTH_POLICY,
    });
  });

  it('never enables query using only write credentials', () => {
    const environment = parseEnv({
      ...baseEnvironment,
      METRICS_WRITE_URL: 'https://metrics.example/api/prom/push',
      METRICS_WRITE_TOKEN: 'write-scoped-token',
    });
    expect(createMetricsConfig(environment)).toEqual({
      query: null,
      health: DEFAULT_VM_HEALTH_POLICY,
    });
  });

  it.each([
    {
      mode: undefined,
      auth: {
        mode: 'basic',
        username: 'tenant',
        token: 'synthetic-read-token',
      },
    },
    {
      mode: '',
      auth: {
        mode: 'basic',
        username: 'tenant',
        token: 'synthetic-read-token',
      },
    },
    {
      mode: '   ',
      auth: {
        mode: 'basic',
        username: 'tenant',
        token: 'synthetic-read-token',
      },
    },
    {
      mode: ' BaSiC ',
      auth: {
        mode: 'basic',
        username: 'tenant',
        token: 'synthetic-read-token',
      },
    },
    {
      mode: ' BeArEr ',
      auth: { mode: 'bearer', token: 'synthetic-read-token' },
    },
    { mode: ' NoNe ', auth: { mode: 'none' } },
  ])(
    'accepts query auth modes without write fallback: $mode',
    ({ mode, auth }) => {
      expect(
        createMetricsConfig(
          parseEnv({
            ...baseEnvironment,
            METRICS_QUERY_URL: 'http://127.0.0.1:8005/workspaces/ws-test/',
            METRICS_QUERY_AUTH_MODE: mode,
            METRICS_USERNAME: ' tenant ',
            METRICS_QUERY_TOKEN: 'synthetic-read-token',
            METRICS_WRITE_AUTH_MODE: 'bearer',
            METRICS_WRITE_TOKEN: 'synthetic-write-token',
          }),
        ),
      ).toEqual({
        query: { baseUrl: 'http://127.0.0.1:8005/workspaces/ws-test', auth },
        health: DEFAULT_VM_HEALTH_POLICY,
      });
    },
  );

  it.each([
    { mode: ' NoNe ', token: 'unused\r\nsecret', auth: { mode: 'none' } },
    {
      mode: ' BeArEr ',
      token: 'synthetic-read-token',
      auth: { mode: 'bearer', token: 'synthetic-read-token' },
    },
  ])('discards unused credentials: $mode', ({ mode, token, auth }) => {
    const config = createMetricsConfig(
      parseEnv({
        ...baseEnvironment,
        METRICS_QUERY_URL: 'http://127.0.0.1:8005/workspaces/ws-test/',
        METRICS_QUERY_AUTH_MODE: mode,
        METRICS_USERNAME: 'unused:bad',
        METRICS_QUERY_TOKEN: token,
      }),
    );
    expect(config.query).toEqual({
      baseUrl: 'http://127.0.0.1:8005/workspaces/ws-test',
      auth,
    });
    expect(config.query).not.toHaveProperty('username');
    expect(config.query).not.toHaveProperty('token');
    expect(config.query).not.toHaveProperty('auth.username');
    if (auth.mode === 'none')
      expect(config.query).not.toHaveProperty('auth.token');
  });

  it.each([undefined, '', '   '])(
    'keeps blank or absent mode disabled without query fields: %s',
    (mode) => {
      expect(
        createMetricsConfig(
          parseEnv({
            ...baseEnvironment,
            METRICS_QUERY_AUTH_MODE: mode,
            METRICS_WRITE_URL: 'https://metrics.example/api/prom/push',
            METRICS_WRITE_TOKEN: 'synthetic-write-token',
            METRICS_WRITE_AUTH_MODE: 'invalid-not-owned',
          }),
        ).query,
      ).toBeNull();
    },
  );

  it('registers query settings under the metrics namespace in NestJS', async () => {
    const environment = { ...baseEnvironment, ...queryEnvironment };
    for (const [key, value] of Object.entries(environment)) {
      vi.stubEnv(key, value);
    }
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          validate: () => parseEnv(environment),
          load: [metricsConfig],
        }),
      ],
    }).compile();
    try {
      const config = module.get(ConfigService);
      expect(config.get('metrics.query')).toEqual(expectedQuery);
      expect(config.get('METRICS_QUERY_TOKEN')).toBe(
        queryEnvironment.METRICS_QUERY_TOKEN,
      );
    } finally {
      await module.close();
    }
  }, 15_000);
});
