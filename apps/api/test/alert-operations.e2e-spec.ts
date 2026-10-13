import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Alert, AlertEvent, Role } from '@prisma/client';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/main.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { CacheService } from '../src/infrastructure/cache/cache.service.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { CognitoTokenVerifierService } from '../src/infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CognitoService } from '../src/infrastructure/aws/cognito/cognito.service.js';
import { CognitoAuthGuard } from '../src/modules/auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../src/modules/authorization/guards/permissions.guard.js';
import { AuthorizationService } from '../src/modules/authorization/authorization.service.js';
import { MembershipsRepository } from '../src/modules/memberships/memberships.repository.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { UsersRepository } from '../src/modules/users/users.repository.js';
import { CsrfOriginGuard } from '../src/common/guards/csrf-origin.guard.js';
import { AUTH_COOKIE_NAMES } from '../src/common/constants/auth.constants.js';
import { AlertRepository } from '../src/modules/alerts/alert.repository.js';
import { MetricsQueryClient } from '../src/infrastructure/metrics/metrics-query.client.js';
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3100',
    WEB_URL: 'https://web.example.invalid',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/no_connection',
    REDIS_URL: 'redis://127.0.0.1:1',
    ENROLLMENT_TOKEN_CACHE_KEY: 'ab'.repeat(32),
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_testpool',
    COGNITO_CLIENT_ID: 'test-client-id',
    COGNITO_CLIENT_SECRET: 'test-client-secret',
    SNS_ALERTS_ENABLED: 'false',
  });
});
const org = '11111111-1111-4111-8111-111111111111',
  foreignOrg = '22222222-2222-4222-8222-222222222222',
  id = '33333333-3333-4333-8333-333333333333',
  missing = '44444444-4444-4444-8444-444444444444',
  web = 'https://web.example.invalid';
const identities: Record<
  string,
  { id: string; role: Role; organizationId: string }
> = {
  admin: {
    id: '55555555-5555-4555-8555-555555555555',
    role: 'ADMIN',
    organizationId: org,
  },
  operator: {
    id: '66666666-6666-4666-8666-666666666666',
    role: 'OPERATOR',
    organizationId: org,
  },
  viewer: {
    id: '77777777-7777-4777-8777-777777777777',
    role: 'VIEWER',
    organizationId: org,
  },
  outsider: {
    id: '88888888-8888-4888-8888-888888888888',
    role: 'ADMIN',
    organizationId: foreignOrg,
  },
};
type RelatedAlert = Alert & { vm: { hostname: string } };
function initial(): RelatedAlert {
  return {
    vm: { hostname: 'fixture-host' },
    id,
    organizationId: org,
    vmId: id,
    source: 'metrics-primary',
    fingerprint: 'fixture',
    alertName: 'VMHighCPU',
    severity: 'WARNING',
    status: 'RESOLVED',
    startsAt: new Date('2026-10-10T00:00:00Z'),
    startsAtKey: '2026-10-10T00:00:00.000000001Z',
    endsAt: new Date('2026-10-10T00:10:00Z'),
    endsAtKey: '2026-10-10T00:10:00.000000001Z',
    workflowStatus: 'OPEN',
    acknowledgedBy: null,
    acknowledgedAt: null,
    labels: { vm_id: id },
    annotations: { summary: 'fixture' },
    createdAt: new Date('2026-10-10T00:01:00Z'),
    updatedAt: new Date('2026-10-10T00:01:00Z'),
  };
}
describe('protected alert operations HTTP (fake external boundaries, real service/guards)', () => {
  let app: INestApplication;
  let row: RelatedAlert;
  let events: AlertEvent[];
  let repository: ReturnType<typeof createRepository>;
  let verifier: ReturnType<typeof vi.fn>;
  let membershipLookupCount: number;
  let listRuleGroups: ReturnType<typeof vi.fn>;
  function createRepository() {
    const owns = (organizationId: string, alertId: string) =>
      organizationId === org && alertId === id;
    return {
      list: vi
        .fn<AlertRepository['list']>()
        .mockImplementation(async (organizationId) => ({
          rows: organizationId === org ? [row] : [],
          total: organizationId === org ? 1 : 0,
        })),
      get: vi
        .fn<AlertRepository['get']>()
        .mockImplementation(async (o, a) => (owns(o, a) ? row : null)),
      events: vi
        .fn<AlertRepository['events']>()
        .mockImplementation(async (o, a) =>
          owns(o, a) ? { rows: events, total: events.length } : null,
        ),
      acknowledge: vi
        .fn<AlertRepository['acknowledge']>()
        .mockImplementation(async (o, a, actor) => {
          if (!owns(o, a)) return null;
          if (row.workflowStatus === 'OPEN')
            row = {
              ...row,
              workflowStatus: 'ACKNOWLEDGED',
              acknowledgedBy: actor,
              acknowledgedAt: new Date(),
            };
          return row;
        }),
      comment: vi
        .fn<AlertRepository['comment']>()
        .mockImplementation(async (o, a, actor, message) => {
          if (!owns(o, a)) return null;
          const event: AlertEvent = {
            id: randomUUID(),
            alertId: a,
            sequence: events.length + 1,
            type: 'COMMENT_ADDED',
            actorId: actor,
            message,
            sourceTimeKey: null,
            createdAt: new Date(),
          };
          events.push(event);
          return event;
        }),
    };
  }
  beforeEach(async () => {
    row = initial();
    events = [];
    repository = createRepository();
    membershipLookupCount = 0;
    listRuleGroups = vi.fn(async () => [
      {
        name: 'opsgrid-vm-health',
        file: 'opsgrid-dev-vm-alerts',
        interval: 60,
        rules: [
          {
            name: 'VMHighCPU',
            type: 'alerting',
            query: 'cpu > 80',
            duration: 300,
            labels: { severity: 'warning' },
            annotations: { summary: 'Shared CPU rule' },
            health: 'ok',
            lastEvaluation: '2026-10-11T01:00:00Z',
            state: 'firing',
            alerts: [
              {
                labels: { organization_id: foreignOrg, vm_id: 'foreign' },
                state: 'firing',
              },
            ],
          },
        ],
      },
    ]);
    verifier = vi.fn(async (token: string) => {
      if (token === 'absent')
        return {
          sub: 'absent',
          client_id: 'test-client-id',
          token_use: 'access',
        };
      if (!identities[token]) throw new UnauthorizedException();
      return {
        sub: `sub-${token}`,
        client_id: 'test-client-id',
        token_use: 'access',
      };
    });
    const prisma = {
      user: {
        findUnique: vi.fn(async (q: { where: { cognitoSub: string } }) => {
          const key = q.where.cognitoSub.replace(/^sub-/, '');
          const user = identities[key];
          return user
            ? {
                id: user.id,
                cognitoSub: q.where.cognitoSub,
                email: `${key}@example.invalid`,
                displayName: null,
              }
            : null;
        }),
      },
      membership: {
        findUnique: vi.fn(
          async (q: {
            where: {
              userId_organizationId: { userId: string; organizationId: string };
            };
          }) => {
            membershipLookupCount++;
            const pair = q.where.userId_organizationId;
            const user = Object.values(identities).find(
              (u) =>
                u.id === pair.userId &&
                u.organizationId === pair.organizationId,
            );
            return user
              ? {
                  id: randomUUID(),
                  userId: user.id,
                  organizationId: pair.organizationId,
                  role: user.role,
                }
              : null;
          },
        ),
      },
    };
    const cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const permissions = new PermissionsGuard(
      new Reflector(),
      new UsersService(new UsersRepository(prisma as unknown as PrismaService)),
      new AuthorizationService(
        new MembershipsRepository(prisma as unknown as PrismaService),
        cache as unknown as CacheService,
      ),
    );
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(CacheService)
      .useValue(cache)
      .overrideProvider(RedisService)
      .useValue({})
      .overrideProvider(CognitoService)
      .useValue({})
      .overrideProvider(CognitoTokenVerifierService)
      .useValue({ verifyAccessToken: verifier })
      .overrideGuard(CognitoAuthGuard)
      .useValue(
        new CognitoAuthGuard({
          verifyAccessToken: verifier,
        } as unknown as CognitoTokenVerifierService),
      )
      .overrideGuard(PermissionsGuard)
      .useValue(permissions)
      .overrideProvider(MetricsQueryClient)
      .useValue({ listRuleGroups })
      .overrideProvider(AlertRepository)
      .useValue(repository)
      .compile();
    app = fixture.createNestApplication();
    // Exercise the existing guard in production mode; APP_GUARD useClass is not replaced by overrideGuard.
    app.useGlobalGuards(
      new CsrfOriginGuard(
        new ConfigService({ app: { nodeEnv: 'production', webUrl: web } }),
      ),
    );
    await configureApp(app, { webUrl: web, nodeEnv: 'test' });
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  const path = `/api/v1/organizations/${org}/alerts`;
  function get(url: string, token = 'admin') {
    return request(app.getHttpServer())
      .get(url)
      .set('Cookie', `${AUTH_COOKIE_NAMES.accessToken}=${token}`);
  }
  function post(url: string, body: unknown = {}, token = 'admin') {
    const operation = request(app.getHttpServer())
      .post(url)
      .set('Cookie', `${AUTH_COOKIE_NAMES.accessToken}=${token}`)
      .set('Origin', web);
    return body === null
      ? operation.set('Content-Type', 'application/json').send('null')
      : operation.send(body);
  }
  const rulesPath = `/api/v1/organizations/${org}/alert-rules`;
  it.each(['admin', 'operator', 'viewer'])(
    'allows %s rule reads and tenant-safe no-store projection',
    async (token) => {
      const response = await get(rulesPath, token).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.items[0]).toMatchObject({
        name: 'VMHighCPU',
        state: 'inactive',
        activeAlerts: 0,
      });
      expect(JSON.stringify(response.body)).not.toContain('foreign');
    },
  );
  it('rejects unauthenticated and bearer-only rule reads before provider access', async () => {
    await get(rulesPath, '').expect(401);
    await request(app.getHttpServer())
      .get(rulesPath)
      .set('Authorization', 'Bearer admin')
      .expect(401);
    expect(listRuleGroups).not.toHaveBeenCalled();
  });
  it('rejects nonmembership and malformed organization before rule provider access', async () => {
    await get(rulesPath, 'outsider').expect(404);
    await get('/api/v1/organizations/invalid/alert-rules').expect(400);
    expect(listRuleGroups).not.toHaveBeenCalled();
  });
  it('does not accept workspace or namespace selectors from clients', async () => {
    await get(rulesPath + '?namespace=private').expect(400);
    expect(listRuleGroups).not.toHaveBeenCalled();
  });
  it('turns malformed provider rules into sanitized 503', async () => {
    listRuleGroups.mockResolvedValue([
      {
        name: 'opsgrid-vm-health',
        file: 'opsgrid-dev-vm-alerts',
        interval: 60,
        rules: [{ name: 'VMHighCPU', query: 'private-provider-value' }],
      },
    ]);
    const response = await get(rulesPath).expect(503);
    expect(response.body.code).toBe('METRICS_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('private-provider');
  });
  it.each(['', 'invalid', 'absent'])(
    'rejects absent/invalid/local-user-missing authentication: %s',
    async (token) => {
      await get(path, token).expect(401);
      expect(repository.list).not.toHaveBeenCalled();
    },
  );
  it('rejects bearer-only without invoking verifier or persistence', async () => {
    await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer admin')
      .expect(401);
    expect(verifier).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('returns nonmember wire404 before a repository access', async () => {
    const response = await get(path, 'outsider').expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('allows Viewer reads with real DTO and no-store', async () => {
    const list = await get(path, 'viewer').expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.body).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 50,
      items: [{ signalStatus: 'RESOLVED', workflowStatus: 'OPEN' }],
    });
    expect(list.body.items[0]).not.toHaveProperty('annotations');
    const detail = await get(`${path}/${id}`, 'viewer').expect(200);
    expect(detail.body).toMatchObject({
      startsAt: row.startsAtKey,
      annotations: { summary: 'fixture' },
    });
    expect(detail.body).not.toHaveProperty('status');
    expect(detail.headers['cache-control']).toBe('no-store');
    const history = await get(`${path}/${id}/events`, 'viewer').expect(200);
    expect(history.body).toMatchObject({ items: [], total: 0 });
    expect(history.headers['cache-control']).toBe('no-store');
  });
  it('passes validated trimmed search and explicit source sorting to the existing tenant repository', async () => {
    await get(
      `${path}?q=%20Edge_%25%20&sort=started_at_asc&page=2&pageSize=5`,
      'viewer',
    ).expect(200);
    expect(repository.list).toHaveBeenCalledWith(org, {
      page: 2,
      pageSize: 5,
      q: 'Edge_%',
      sort: 'started_at_asc',
    });
  });
  it.each(['acknowledge', 'comments'])(
    'denies Viewer %s before alert lookup',
    async (action) => {
      await post(
        `${path}/${id}/${action}`,
        action === 'comments' ? { message: 'note' } : {},
        'viewer',
      ).expect(403);
      expect(repository.acknowledge).not.toHaveBeenCalled();
      expect(repository.comment).not.toHaveBeenCalled();
      expect(repository.get).not.toHaveBeenCalled();
    },
  );
  it.each(['admin', 'operator'])(
    'acknowledges resolved OPEN with local UUID and returns winner: %s',
    async (token) => {
      const first = await post(`${path}/${id}/acknowledge`, {}, token).expect(
        200,
      );
      expect(first.headers['cache-control']).toBe('no-store');
      expect(first.body).toMatchObject({
        signalStatus: 'RESOLVED',
        workflowStatus: 'ACKNOWLEDGED',
        acknowledgedBy: identities[token].id,
      });
      const repeat = await post(
        `${path}/${id}/acknowledge`,
        {},
        token === 'admin' ? 'operator' : 'admin',
      ).expect(200);
      expect(repeat.body).toEqual(first.body);
      expect(repository.acknowledge).toHaveBeenCalledWith(
        org,
        id,
        identities[token].id,
        expect.any(Number),
      );
    },
  );
  it('allows Unicode comments without ACK and after resolution; repeated POSTs are distinct', async () => {
    const a = await post(
      `${path}/${id}/comments`,
      { message: '  note 😀\n plus+  ' },
      'operator',
    ).expect(201);
    const b = await post(
      `${path}/${id}/comments`,
      { message: 'note 😀\n plus+' },
      'operator',
    ).expect(201);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.body).toMatchObject({
      actorId: identities.operator.id,
      message: 'note 😀\n plus+',
      sequence: 1,
    });
    expect(b.body.sequence).toBe(2);
    expect(a.body.id).not.toBe(b.body.id);
    expect(row.workflowStatus).toBe('OPEN');
    expect(row.status).toBe('RESOLVED');
  });
  it.each(['detail', 'events', 'acknowledge', 'comments'])(
    'returns scoped RESOURCE_NOT_FOUND for foreign/missing %s',
    async (action) => {
      const response =
        action === 'detail'
          ? await get(`${path}/${missing}`).expect(404)
          : action === 'events'
            ? await get(`${path}/${missing}/events`).expect(404)
            : await post(
                `${path}/${missing}/${action}`,
                action === 'comments' ? { message: 'note' } : {},
              ).expect(404);
      expect(response.body.code).toBe('RESOURCE_NOT_FOUND');
    },
  );
  it.each([
    'page=0',
    'pageSize=101',
    'severity=LOW',
    'signalStatus=OPEN',
    'workflowStatus=RESOLVED',
    'vmId=bad',
    'extra=1',
  ])('validates list query %s', async (query) => {
    await get(`${path}?${query}`).expect(400);
    expect(repository.list).not.toHaveBeenCalled();
  });
  it.each(['list', 'detail', 'events', 'acknowledge', 'comments'])(
    'rejects malformed tenant UUID before membership lookup: %s',
    async (action) => {
      const invalid = '/api/v1/organizations/not-a-uuid/alerts';
      const response =
        action === 'list'
          ? await get(invalid).expect(400)
          : action === 'detail'
            ? await get(`${invalid}/${id}`).expect(400)
            : action === 'events'
              ? await get(`${invalid}/${id}/events`).expect(400)
              : await post(
                  `${invalid}/${id}/${action}`,
                  action === 'comments' ? { message: 'note' } : {},
                ).expect(400);
      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(membershipLookupCount).toBe(0);
      expect(repository.list).not.toHaveBeenCalled();
      expect(repository.acknowledge).not.toHaveBeenCalled();
      expect(repository.comment).not.toHaveBeenCalled();
    },
  );
  it('keeps authentication first on a malformed tenant UUID', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/organizations/not-a-uuid/alerts')
      .expect(401);
    expect(membershipLookupCount).toBe(0);
  });
  it('validates UUID/event pagination and forwards valid filters', async () => {
    await get(`${path}/bad`).expect(400);
    await get(`${path}/${id}/events?severity=WARNING`).expect(400);
    await get(
      `${path}?page=2&pageSize=1&severity=WARNING&signalStatus=RESOLVED&workflowStatus=OPEN&vmId=${id}`,
    ).expect(200);
    expect(repository.list).toHaveBeenCalledWith(org, {
      page: 2,
      pageSize: 1,
      severity: 'WARNING',
      signalStatus: 'RESOLVED',
      workflowStatus: 'OPEN',
      vmId: id,
    });
  });
  it.each([
    { actorId: id },
    { organizationId: foreignOrg },
    { signalStatus: 'RESOLVED' },
    null,
  ])('rejects acknowledgement body smuggling %j', async (body) => {
    await post(`${path}/${id}/acknowledge`, body).expect(400);
    expect(repository.acknowledge).not.toHaveBeenCalled();
  });
  it.each([
    { message: '' },
    { message: '  ' },
    { message: 'a\u0000b' },
    { message: 'x'.repeat(4001) },
    { message: 'valid', actorId: id },
    { message: '\ud800' },
  ])('rejects invalid comment input %j', async (body) => {
    await post(`${path}/${id}/comments`, body).expect(400);
    expect(repository.comment).not.toHaveBeenCalled();
  });
  it('keeps production Origin and Referer checks before persistence', async () => {
    await request(app.getHttpServer())
      .post(`${path}/${id}/acknowledge`)
      .set('Cookie', `${AUTH_COOKIE_NAMES.accessToken}=admin`)
      .send({})
      .expect(403);
    await post(`${path}/${id}/acknowledge`)
      .set('Origin', 'https://wrong.example.invalid')
      .expect(403);
    await post(`${path}/${id}/comments`, { message: 'note' })
      .set('Referer', 'https://wrong.example.invalid/path')
      .expect(403);
    expect(repository.acknowledge).not.toHaveBeenCalled();
    expect(repository.comment).not.toHaveBeenCalled();
  });
  it('returns safe transient503 rather than leaking raw provider errors', async () => {
    repository.get.mockRejectedValue(new Error('private SQL text'));
    const response = await get(`${path}/${id}`).expect(503);
    expect(JSON.stringify(response.body)).not.toContain('private SQL');
  });
});
