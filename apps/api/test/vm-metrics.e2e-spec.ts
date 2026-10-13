import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  type INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/main.js';
import { authConfig } from '../src/config/auth.config.js';
import { metricsConfig } from '../src/config/metrics.config.js';
import { CognitoService } from '../src/infrastructure/aws/cognito/cognito.service.js';
import { CognitoTokenVerifierService } from '../src/infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { CacheService } from '../src/infrastructure/cache/cache.service.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { MetricsQueryClient } from '../src/infrastructure/metrics/metrics-query.client.js';
import { CognitoAuthGuard } from '../src/modules/auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../src/modules/authorization/guards/permissions.guard.js';
import { AuthorizationService } from '../src/modules/authorization/authorization.service.js';
import { MembershipsRepository } from '../src/modules/memberships/memberships.repository.js';
import { UsersRepository } from '../src/modules/users/users.repository.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { VmsRepository } from '../src/modules/vms/vms.repository.js';
import type { VmRecord } from '../src/modules/vms/vms.types.js';
vi.hoisted(() =>
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3100',
    WEB_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_testpool',
    COGNITO_CLIENT_ID: 'test-client',
    COGNITO_CLIENT_SECRET: 'test-secret',
  }),
);
const ORG = '00000000-0000-4000-8000-000000000001';
const FOREIGN = '00000000-0000-4000-8000-000000000002';
const VM = '00000000-0000-4000-8000-000000000011';
const AGENT = '00000000-0000-4000-8000-000000000041';
const NOW = 1_800_000_000;
const BASE = `/api/v1/organizations/${ORG}/vms`;
function row(metric: string, value: number) {
  return {
    labels: {
      organization_id: ORG,
      vm_id: VM,
      agent_id: AGENT,
      __ops_metric: metric,
    },
    timestamp: NOW,
    value,
  };
}
function fixture(): VmRecord {
  return {
    id: VM,
    organizationId: ORG,
    hostname: 'test-vm',
    ipAddress: null,
    os: 'Linux',
    status: 'DISCONNECTED',
    createdAt: new Date(),
    updatedAt: new Date(),
    tags: [{ id: 'tag-1', key: 'env', value: 'test' }],
    agent: {
      id: AGENT,
      status: 'ACTIVE',
      enrolledAt: new Date(),
      lastSeenAt: null,
    },
  };
}
describe('authenticated real VM telemetry HTTP contracts (controlled infrastructure)', () => {
  let app: INestApplication<App>;
  let record: VmRecord;
  let provider: {
    query: ReturnType<typeof vi.fn>;
    queryRange: ReturnType<typeof vi.fn>;
    assertEnabled: ReturnType<typeof vi.fn>;
  };
  let repo: {
    getById: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
  };
  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
    record = fixture();
    provider = {
      assertEnabled: vi.fn(),
      query: vi.fn(async (q: string) =>
        q.includes('"__ops_metric", "heartbeat"')
          ? [row('cpu', NOW), row('heartbeat', NOW)]
          : [row('cpu', 0)],
      ),
      queryRange: vi.fn(async () => [
        {
          labels: row('cpu', 0).labels,
          values: [
            { timestamp: NOW - 60, value: 0 },
            { timestamp: NOW, value: null },
          ],
        },
      ]),
    };
    repo = {
      getById: vi.fn(async (org: string, id: string) =>
        org === ORG && id === VM ? record : null,
      ),
      list: vi.fn(async () => ({
        items: [record],
        page: 1,
        pageSize: 50,
        total: 1,
      })),
    };
    const verifier = {
      verifyAccessToken: vi.fn(async (token: string) => {
        if (token !== 'viewer-token') throw new Error('invalid');
        return { sub: 'viewer', token_use: 'access', client_id: 'test-client' };
      }),
    };
    const prisma = {
      user: {
        findUnique: vi.fn(async () => ({
          id: 'user',
          cognitoSub: 'viewer',
          email: 'viewer@example.com',
          displayName: null,
        })),
      },
      membership: {
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { userId_organizationId: { organizationId: string } };
          }) =>
            where.userId_organizationId.organizationId === ORG
              ? {
                  id: 'membership',
                  userId: 'user',
                  organizationId: ORG,
                  role: 'VIEWER',
                }
              : null,
        ),
      },
    };
    const cache = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const guard = new PermissionsGuard(
      new Reflector(),
      new UsersService(new UsersRepository(prisma as unknown as PrismaService)),
      new AuthorizationService(
        new MembershipsRepository(prisma as unknown as PrismaService),
        cache as unknown as CacheService,
      ),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CognitoService)
      .useValue({})
      .overrideProvider(CognitoTokenVerifierService)
      .useValue(verifier)
      .overrideGuard(CognitoAuthGuard)
      .useValue(
        new CognitoAuthGuard(
          verifier as unknown as CognitoTokenVerifierService,
        ),
      )
      .overrideGuard(PermissionsGuard)
      .useValue(guard)
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(CacheService)
      .useValue(cache)
      .overrideProvider(RedisService)
      .useValue({ ping: vi.fn(async () => 'PONG') })
      .overrideProvider(VmsRepository)
      .useValue(repo)
      .overrideProvider(MetricsQueryClient)
      .useValue(provider)
      .overrideProvider(authConfig.KEY)
      .useValue({
        region: 'ap-southeast-1',
        userPoolId: 'ap-southeast-1_testpool',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      })
      .overrideProvider(metricsConfig.KEY)
      .useValue({ query: null })
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await configureApp(app, {
      nodeEnv: 'test',
      webUrl: 'http://localhost:5173',
    });
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.useRealTimers();
  });
  function get(path: string, token = 'viewer-token') {
    return request(app.getHttpServer())
      .get(path)
      .set('Cookie', `access_token=${token}`);
  }
  it('rejects absent/invalid cookie and ignores bearer tokens without provider access', async () => {
    await request(app.getHttpServer())
      .get(`${BASE}/${VM}/metrics/current`)
      .expect(401);
    await request(app.getHttpServer())
      .get(`${BASE}/${VM}/metrics/current`)
      .set('Authorization', 'Bearer viewer-token')
      .expect(401);
    await get(`${BASE}/${VM}/metrics/current`, 'invalid').expect(401);
    expect(provider.query).not.toHaveBeenCalled();
    expect(repo.getById).not.toHaveBeenCalled();
  });
  it('denies nonmember organization and missing/foreign VM before telemetry/cache reads', async () => {
    await get(
      `/api/v1/organizations/${FOREIGN}/vms/${VM}/metrics/current`,
    ).expect(404);
    await get(`${BASE}/${FOREIGN}/metrics/current`).expect(404);
    repo.getById.mockResolvedValue({ ...record, organizationId: FOREIGN });
    await get(`${BASE}/${VM}/metrics/current`).expect(404);
    expect(provider.query).not.toHaveBeenCalled();
  });
  it('validates UUID/window/mixed query and cannot accept arbitrary PromQL', async () => {
    await get(`${BASE}/bad/metrics/current`).expect(400);
    for (const query of [
      'range=bad',
      'range=1h&query=up',
      'range=1h&from=1',
      'from=1&to=2&step=0',
      'from=1&to=700000&step=1',
      'from=2&to=1&step=1',
    ])
      await get(`${BASE}/${VM}/metrics/range?${query}`).expect(400);
    expect(provider.query).not.toHaveBeenCalled();
    expect(provider.queryRange).not.toHaveBeenCalled();
  });
  it('allows viewer current data, exact agent binding, nullable fields and zero', async () => {
    const response = await get(`${BASE}/${VM}/metrics/current`).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      status: 'HEALTHY',
      metricsState: 'available',
      sampledAt: new Date(NOW * 1000).toISOString(),
      metrics: { cpu: 0, memory: null, disk: null },
    });
    expect(provider.query).toHaveBeenCalledTimes(2);
    expect(provider.query.mock.calls[0][0]).toContain(
      `organization_id="${ORG}"`,
    );
    expect(provider.query.mock.calls[0][0]).toContain(`agent_id=~"${AGENT}"`);
  });
  it('retains inventory envelopes/tags with enriched derived status and no per-row HTTP reads', async () => {
    const page = await get(BASE).expect(200);
    const detail = await get(`${BASE}/${VM}`).expect(200);
    expect(page.body).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 1,
      items: [
        {
          status: 'HEALTHY',
          metricsState: 'available',
          metrics: { cpu: 0 },
          tags: record.tags,
        },
      ],
    });
    expect(detail.body).toMatchObject({
      status: 'HEALTHY',
      agent: { id: AGENT },
      metrics: { cpu: 0 },
      tags: record.tags,
    });
    expect(provider.query).toHaveBeenCalledTimes(2);
  });
  it('returns normalized historical series and preserves gaps rather than filling zero', async () => {
    const response = await get(`${BASE}/${VM}/metrics/range?range=1h`).expect(
      200,
    );
    expect(response.body).toMatchObject({
      step: 60,
      series: {
        cpu: [
          { timestamp: new Date((NOW - 60) * 1000).toISOString(), value: 0 },
          { timestamp: new Date(NOW * 1000).toISOString(), value: null },
        ],
      },
    });
    expect(provider.queryRange).toHaveBeenCalledTimes(6);
  });
  it.each(['1h', '6h', '24h', '7d'])(
    'returns real preset %s history when polling is shifted by 30 seconds',
    async (range) => {
      vi.setSystemTime((NOW + 30) * 1000);
      const response = await get(
        `${BASE}/${VM}/metrics/range?range=${range}`,
      ).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.to).toBe(new Date(NOW * 1000).toISOString());
      expect(response.body.series.cpu).toContainEqual({
        timestamp: new Date(NOW * 1000).toISOString(),
        value: null,
      });
    },
  );
  it('keeps exact explicit HTTP bounds while returning the demonstrated AMP epoch grid', async () => {
    provider.queryRange.mockResolvedValue([
      {
        labels: row('cpu', 0).labels,
        values: [
          { timestamp: 1791541860, value: 45.16823873988146 },
          { timestamp: 1791543900, value: 52.281543322340355 },
        ],
      },
    ]);
    const response = await get(
      `${BASE}/${VM}/metrics/range?from=1791540330&to=1791543930&step=60`,
    ).expect(200);
    expect(response.body).toMatchObject({
      from: '2026-10-09T10:05:30.000Z',
      to: '2026-10-09T11:05:30.000Z',
      step: 60,
      series: {
        cpu: [
          { timestamp: '2026-10-09T10:31:00.000Z', value: 45.16823873988146 },
          { timestamp: '2026-10-09T11:05:00.000Z', value: 52.281543322340355 },
        ],
      },
    });
  });
  it('returns safe 503 for ambiguous mixed evaluation grids', async () => {
    provider.queryRange.mockResolvedValue([
      {
        labels: row('cpu', 0).labels,
        values: [
          { timestamp: 1791540330, value: 0 },
          { timestamp: 1791540360, value: 1 },
        ],
      },
    ]);
    const response = await get(
      `${BASE}/${VM}/metrics/range?from=1791540330&to=1791543930&step=60`,
    ).expect(503);
    expect(response.body).toEqual({
      statusCode: 503,
      code: 'METRICS_UNAVAILABLE',
      message: 'Metrics are temporarily unavailable',
    });
  });
  it('returns safe 503 for duplicate aggregate identity rows, rather than merging oversized range series', async () => {
    provider.queryRange.mockResolvedValue(
      [0, 1000].map((offset) => ({
        labels: row('cpu', 0).labels,
        values: Array.from({ length: 1000 }, (_, i) => ({
          timestamp: NOW - 3600 + offset + i,
          value: 1,
        })),
      })),
    );
    const response = await get(`${BASE}/${VM}/metrics/range?range=1h`).expect(
      503,
    );
    expect(response.body).toEqual({
      statusCode: 503,
      code: 'METRICS_UNAVAILABLE',
      message: 'Metrics are temporarily unavailable',
    });
  });
  it('keeps fresh critical CPU when memory source timestamps are stale or missing', async () => {
    provider.query.mockImplementation(async (q: string) =>
      q.includes('"__ops_metric", "heartbeat"')
        ? [
            row('cpu', NOW - 1),
            row('memory', NOW - 301),
            row('heartbeat', NOW - 301),
          ]
        : [row('cpu', 96), row('memory', 95)],
    );
    expect(
      (await get(`${BASE}/${VM}/metrics/current`).expect(200)).body,
    ).toMatchObject({
      status: 'CRITICAL',
      sampledAt: new Date((NOW - 1) * 1000).toISOString(),
      lastSeenAt: new Date((NOW - 1) * 1000).toISOString(),
      metrics: { cpu: 96, memory: null },
    });
  });
  it('reports empty data and revoked/no agents as disconnected without invented values', async () => {
    provider.query.mockResolvedValue([]);
    expect(
      (await get(`${BASE}/${VM}/metrics/current`).expect(200)).body,
    ).toMatchObject({
      status: 'DISCONNECTED',
      metricsState: 'empty',
      sampledAt: null,
      lastSeenAt: null,
      metrics: { cpu: null },
    });
    provider.query.mockClear();
    record.agent = null;
    expect(
      (await get(`${BASE}/${VM}/metrics/current`).expect(200)).body.status,
    ).toBe('DISCONNECTED');
    expect(provider.query).not.toHaveBeenCalled();
  });
  it.each(['METRICS_DISABLED', 'METRICS_UNAVAILABLE'])(
    'returns safe %s and best-effort inventory',
    async (code) => {
      provider.query.mockRejectedValue(
        new ServiceUnavailableException({
          code,
          message: 'synthetic-token provider url',
          details: 'secret',
        }),
      );
      const response = await get(`${BASE}/${VM}/metrics/current`).expect(503);
      expect(response.body).toEqual({
        statusCode: 503,
        code,
        message:
          code === 'METRICS_DISABLED'
            ? 'Metrics are not configured'
            : 'Metrics are temporarily unavailable',
      });
      expect((await get(BASE).expect(200)).body.items[0]).toMatchObject({
        status: 'DISCONNECTED',
        metricsState: code === 'METRICS_DISABLED' ? 'disabled' : 'unavailable',
        metrics: { cpu: null },
      });
    },
  );
});
