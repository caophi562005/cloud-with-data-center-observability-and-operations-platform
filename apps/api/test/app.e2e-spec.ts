import { Test, type TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/main.js';
import { authConfig, type AuthConfig } from '../src/config/auth.config.js';
import { CognitoService } from '../src/infrastructure/aws/cognito/cognito.service.js';
import { CognitoTokenVerifierService } from '../src/infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CognitoAuthGuard } from '../src/modules/auth/guards/cognito-auth.guard.js';
import { CacheService } from '../src/infrastructure/cache/cache.service.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { MembershipsRepository } from '../src/modules/memberships/memberships.repository.js';
import { AuthorizationService } from '../src/modules/authorization/authorization.service.js';
import { PermissionsGuard } from '../src/modules/authorization/guards/permissions.guard.js';
import { UsersRepository } from '../src/modules/users/users.repository.js';
import { UsersService } from '../src/modules/users/users.service.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PORT: '3100',
    WEB_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/cloudops_test',
    REDIS_URL: 'redis://localhost:6379',
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_testpool',
    COGNITO_CLIENT_ID: 'test-client-id',
    COGNITO_CLIENT_SECRET: 'test-client-secret',
  });
});

type TestRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

type TestUser = {
  id: string;
  cognitoSub: string;
  email: string;
  displayName: string | null;
};

type TestOrganization = {
  id: string;
  name: string;
  slug: string;
};

type TestMembership = {
  id: string;
  userId: string;
  organizationId: string;
  role: TestRole;
};

type TestState = {
  usersBySub: Map<string, TestUser>;
  usersById: Map<string, TestUser>;
  organizations: Map<string, TestOrganization>;
  memberships: Map<string, TestMembership>;
};

type TestSession = {
  user: TestUser;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  refreshGeneration: number;
  revoked: boolean;
};

type UserFindUniqueArgs = {
  where: { cognitoSub: string };
};

type UserUpsertArgs = {
  where: { cognitoSub: string };
  create: { cognitoSub: string; email: string; displayName?: string };
  update: { email: string; displayName?: string };
};

type OrganizationFindUniqueArgs = {
  where: { id: string };
};

type OrganizationUpdateArgs = {
  where: { id: string };
  data: { name?: string; slug?: string };
};

type MembershipFindManyArgs = {
  where: { userId?: string; organizationId?: string };
  select: Record<string, unknown>;
};

type MembershipFindUniqueArgs = {
  where: {
    userId_organizationId: { userId: string; organizationId: string };
  };
};

type MembershipCreateArgs = {
  data: {
    organization: { connect: { id: string } };
    user: { connect: { id: string } };
    role: TestRole;
  };
};

type MembershipUpdateArgs = {
  where: {
    userId_organizationId: { userId: string; organizationId: string };
  };
  data: { role: TestRole };
};

type MembershipDeleteArgs = MembershipFindUniqueArgs;

const TEST_CLIENT_ID = 'test-client-id';
const TEST_WEB_URL = 'http://localhost:5173';
const TEST_PASSWORD = 'Correct-horse-battery-123';
const TEST_AUTH_CONFIG: AuthConfig = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_testpool',
  clientId: TEST_CLIENT_ID,
  clientSecret: 'test-client-secret',
};

function membershipKey(userId: string, organizationId: string): string {
  return `${userId}:${organizationId}`;
}

function createTestState(): TestState {
  const users: TestUser[] = [
    {
      id: 'user-admin',
      cognitoSub: 'cognito-sub-admin',
      email: 'admin@example.com',
      displayName: 'Admin User',
    },
    {
      id: 'user-operator',
      cognitoSub: 'cognito-sub-operator',
      email: 'operator@example.com',
      displayName: 'Operator User',
    },
    {
      id: 'user-viewer',
      cognitoSub: 'cognito-sub-viewer',
      email: 'viewer@example.com',
      displayName: 'Viewer User',
    },
    {
      id: 'user-empty',
      cognitoSub: 'cognito-sub-empty',
      email: 'empty@example.com',
      displayName: 'No Membership User',
    },
  ];
  const organizations: TestOrganization[] = [
    {
      id: 'organization-one',
      name: 'Organization One',
      slug: 'organization-one',
    },
    {
      id: 'organization-two',
      name: 'Organization Two',
      slug: 'organization-two',
    },
  ];
  const memberships: TestMembership[] = [
    {
      id: 'membership-admin',
      userId: 'user-admin',
      organizationId: 'organization-one',
      role: 'ADMIN',
    },
    {
      id: 'membership-operator',
      userId: 'user-operator',
      organizationId: 'organization-one',
      role: 'OPERATOR',
    },
    {
      id: 'membership-viewer',
      userId: 'user-viewer',
      organizationId: 'organization-one',
      role: 'VIEWER',
    },
  ];

  return {
    usersBySub: new Map(users.map((user) => [user.cognitoSub, user])),
    usersById: new Map(users.map((user) => [user.id, user])),
    organizations: new Map(
      organizations.map((organization) => [organization.id, organization]),
    ),
    memberships: new Map(
      memberships.map((membership) => [
        membershipKey(membership.userId, membership.organizationId),
        membership,
      ]),
    ),
  };
}

function createPrismaDouble(state: TestState) {
  const findUser = vi.fn(async ({ where }: UserFindUniqueArgs) => {
    return state.usersBySub.get(where.cognitoSub) ?? null;
  });
  const upsertUser = vi.fn(
    async ({ where, create, update }: UserUpsertArgs) => {
      const current = state.usersBySub.get(where.cognitoSub);
      const user: TestUser = current
        ? {
            ...current,
            email: update.email,
            ...(update.displayName !== undefined
              ? { displayName: update.displayName }
              : {}),
          }
        : {
            id: `user-${where.cognitoSub}`,
            cognitoSub: create.cognitoSub,
            email: create.email,
            displayName: create.displayName ?? null,
          };

      state.usersBySub.set(user.cognitoSub, user);
      state.usersById.set(user.id, user);
      return user;
    },
  );

  const findOrganization = vi.fn(
    async ({ where }: OrganizationFindUniqueArgs) => {
      return state.organizations.get(where.id) ?? null;
    },
  );
  const updateOrganization = vi.fn(
    async ({ where, data }: OrganizationUpdateArgs) => {
      const current = state.organizations.get(where.id);
      if (!current) {
        throw Object.assign(new Error('organization not found'), {
          code: 'P2025',
        });
      }
      const organization = { ...current, ...data };
      state.organizations.set(organization.id, organization);
      return organization;
    },
  );

  const findMemberships = vi.fn(
    async ({ where, select }: MembershipFindManyArgs) => {
      const memberships = [...state.memberships.values()].filter(
        (membership) => {
          return (
            (where.userId === undefined ||
              membership.userId === where.userId) &&
            (where.organizationId === undefined ||
              membership.organizationId === where.organizationId)
          );
        },
      );

      if (select.organization) {
        return memberships.map((membership) => ({
          role: membership.role,
          organization: state.organizations.get(membership.organizationId),
        }));
      }

      return memberships.map((membership) => ({
        id: membership.id,
        userId: membership.userId,
        role: membership.role,
        user: state.usersById.get(membership.userId),
      }));
    },
  );
  const findMembership = vi.fn(async ({ where }: MembershipFindUniqueArgs) => {
    const { userId, organizationId } = where.userId_organizationId;
    const membership = state.memberships.get(
      membershipKey(userId, organizationId),
    );
    return membership
      ? {
          id: membership.id,
          userId: membership.userId,
          organizationId: membership.organizationId,
          role: membership.role,
        }
      : null;
  });
  const createMembership = vi.fn(async ({ data }: MembershipCreateArgs) => {
    const organizationId = data.organization.connect.id;
    const userId = data.user.connect.id;
    const membership: TestMembership = {
      id: `membership-${userId}-${organizationId}`,
      userId,
      organizationId,
      role: data.role,
    };
    state.memberships.set(membershipKey(userId, organizationId), membership);
    return {
      id: membership.id,
      userId: membership.userId,
      role: membership.role,
      user: state.usersById.get(userId),
    };
  });
  const updateMembership = vi.fn(
    async ({ where, data }: MembershipUpdateArgs) => {
      const { userId, organizationId } = where.userId_organizationId;
      const current = state.memberships.get(
        membershipKey(userId, organizationId),
      );
      if (!current) {
        throw Object.assign(new Error('membership not found'), {
          code: 'P2025',
        });
      }
      const membership = { ...current, role: data.role };
      state.memberships.set(membershipKey(userId, organizationId), membership);
      return {
        id: membership.id,
        userId: membership.userId,
        role: membership.role,
        user: state.usersById.get(userId),
      };
    },
  );
  const deleteMembership = vi.fn(async ({ where }: MembershipDeleteArgs) => {
    const { userId, organizationId } = where.userId_organizationId;
    const key = membershipKey(userId, organizationId);
    if (!state.memberships.delete(key)) {
      throw Object.assign(new Error('membership not found'), { code: 'P2025' });
    }
  });

  return {
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
    user: { findUnique: findUser, upsert: upsertUser },
    organization: {
      findUnique: findOrganization,
      update: updateOrganization,
    },
    membership: {
      findMany: findMemberships,
      findUnique: findMembership,
      create: createMembership,
      update: updateMembership,
      delete: deleteMembership,
    },
  };
}

class InMemoryCacheDouble {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return this.values.has(key) ? (this.values.get(key) as T) : null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.values.delete(key);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) {
        this.values.delete(key);
      }
    }
  }
}

function createCognitoDoubles(state: TestState) {
  const sessions = new Map<string, TestSession>();
  const sessionForAccessToken = (token: string): TestSession | undefined =>
    [...sessions.values()].find(
      (session) => session.accessToken === token && !session.revoked,
    );
  const sessionForIdToken = (token: string): TestSession | undefined =>
    [...sessions.values()].find(
      (session) => session.idToken === token && !session.revoked,
    );

  const signInWithPassword = vi.fn(async (email: string, password: string) => {
    const user = [...state.usersBySub.values()].find(
      (candidate) => candidate.email === email,
    );
    if (!user || password !== TEST_PASSWORD) {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    const session: TestSession = {
      user,
      accessToken: `access-${user.id}-initial`,
      idToken: `id-${user.id}`,
      refreshToken: `refresh-${user.id}-initial`,
      refreshGeneration: 0,
      revoked: false,
    };
    sessions.set(user.cognitoSub, session);
    return {
      accessToken: session.accessToken,
      idToken: session.idToken,
      refreshToken: session.refreshToken,
    };
  });

  const pendingRegistrations = new Map<
    string,
    { code: string; user: TestUser }
  >();
  const signUp = vi.fn(
    async (email: string, _password: string, displayName: string) => {
      if ([...state.usersBySub.values()].some((user) => user.email === email)) {
        throw new ConflictException({
          code: 'AUTH_REGISTRATION_PENDING',
          message: 'Registration may already be pending',
        });
      }

      const user: TestUser = {
        id: `user-${email}`,
        cognitoSub: `cognito-sub-${email}`,
        email,
        displayName,
      };
      state.usersBySub.set(user.cognitoSub, user);
      state.usersById.set(user.id, user);
      pendingRegistrations.set(email, { code: '123456', user });
      return {
        userConfirmed: false,
        codeDeliveryDetails: {
          attributeName: 'email',
          deliveryMedium: 'EMAIL',
          destination: 'n***@example.com',
        },
      };
    },
  );

  const confirmSignUp = vi.fn(async (email: string, code: string) => {
    const pending = pendingRegistrations.get(email);
    if (!pending || pending.code !== code) {
      throw new BadRequestException({
        code: 'AUTH_CONFIRMATION_INVALID',
        message: 'Confirmation code is invalid or expired',
      });
    }
    pendingRegistrations.delete(email);
  });

  const resendConfirmationCode = vi.fn(async (email: string) => {
    const pending = pendingRegistrations.get(email);
    if (!pending) {
      throw new BadRequestException({
        code: 'AUTH_REGISTRATION_FAILED',
        message: 'Registration could not be completed',
      });
    }
    return {
      attributeName: 'email',
      deliveryMedium: 'EMAIL',
      destination: 'n***@example.com',
    };
  });

  const refreshToken = vi.fn(async (refresh: string, username?: string) => {
    const session = [...sessions.values()].find(
      (candidate) => candidate.refreshToken === refresh && !candidate.revoked,
    );
    if (
      !session ||
      (username !== undefined && username !== session.user.email)
    ) {
      throw new UnauthorizedException({
        code: 'AUTH_UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    session.refreshGeneration += 1;
    session.accessToken = `access-${session.user.id}-refresh-${session.refreshGeneration}`;
    session.refreshToken = `refresh-${session.user.id}-refresh-${session.refreshGeneration}`;
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  });

  const revokeToken = vi.fn(async (refresh: string) => {
    const session = [...sessions.values()].find(
      (candidate) => candidate.refreshToken === refresh,
    );
    if (session) {
      session.revoked = true;
    }
  });

  const verifyAccessToken = vi.fn(async (token: string) => {
    const session = sessionForAccessToken(token);
    if (!session) {
      throw new UnauthorizedException('invalid access token');
    }
    return {
      sub: session.user.cognitoSub,
      client_id: TEST_CLIENT_ID,
      token_use: 'access' as const,
      scope: 'openid',
    };
  });

  const verifyIdToken = vi.fn(async (token: string) => {
    const session = sessionForIdToken(token);
    if (!session) {
      throw new UnauthorizedException('invalid id token');
    }
    return {
      sub: session.user.cognitoSub,
      aud: TEST_CLIENT_ID,
      token_use: 'id' as const,
      email: session.user.email,
      ...(session.user.displayName ? { name: session.user.displayName } : {}),
    };
  });

  return {
    cognito: {
      signInWithPassword,
      signUp,
      confirmSignUp,
      resendConfirmationCode,
      refreshToken,
      revokeToken,
    },
    verifier: { verifyAccessToken, verifyIdToken },
  };
}

type TestDoubles = {
  cognito: ReturnType<typeof createCognitoDoubles>['cognito'];
  verifier: ReturnType<typeof createCognitoDoubles>['verifier'];
  prisma: ReturnType<typeof createPrismaDouble>;
  cache: InMemoryCacheDouble;
  redis: { ping: ReturnType<typeof vi.fn> };
};

function createTestDoubles(state: TestState): TestDoubles {
  const cognitoDoubles = createCognitoDoubles(state);
  return {
    ...cognitoDoubles,
    prisma: createPrismaDouble(state),
    cache: new InMemoryCacheDouble(),
    redis: { ping: vi.fn().mockResolvedValue(true) },
  };
}

function cookieHeaders(response: {
  headers: Record<string, unknown>;
}): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value)
    ? value.filter((cookie): cookie is string => typeof cookie === 'string')
    : [];
}

function cookieValue(headers: string[], name: string): string {
  const header = headers.find((cookie) => cookie.startsWith(`${name}=`));
  expect(header).toBeDefined();
  return header?.slice(name.length + 1).split(';', 1)[0] ?? '';
}

function expectSetCookieAttributes(
  headers: string[],
  name: string,
  maxAge: string,
): void {
  const header = headers.find((cookie) => cookie.startsWith(`${name}=`));
  expect(header).toBeDefined();
  expect(header).toContain(`Max-Age=${maxAge}`);
  expect(header).toContain('Path=/');
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Lax');
  expect(header).not.toContain('Secure');
  expect(header).not.toContain(TEST_PASSWORD);
}

function expectClearedCookieAttributes(headers: string[], name: string): void {
  const header = headers.find((cookie) => cookie.startsWith(`${name}=;`));
  expect(header).toBeDefined();
  expect(header).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  expect(header).toContain('Path=/');
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Lax');
  expect(header).not.toContain(TEST_PASSWORD);
}

function expectSafeJson(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(
    /password|accessToken|refreshToken|idToken|clientSecret|DATABASE_URL|REDIS_URL|postgres(?:ql)?:|redis(?:s)?:/i,
  );
}

describe('CloudOps API contracts (e2e)', () => {
  let app: INestApplication<App> | undefined;
  let doubles: TestDoubles;

  beforeEach(async () => {
    const state = createTestState();
    doubles = createTestDoubles(state);
    const permissionsGuard = new PermissionsGuard(
      new Reflector(),
      new UsersService(
        new UsersRepository(doubles.prisma as unknown as PrismaService),
      ),
      new AuthorizationService(
        new MembershipsRepository(doubles.prisma as unknown as PrismaService),
        doubles.cache as unknown as CacheService,
      ),
    );
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CognitoService)
      .useValue(doubles.cognito)
      .overrideProvider(CognitoTokenVerifierService)
      .useValue(doubles.verifier)
      .overrideGuard(CognitoAuthGuard)
      .useValue(
        new CognitoAuthGuard(
          doubles.verifier as unknown as CognitoTokenVerifierService,
        ),
      )
      .overrideGuard(PermissionsGuard)
      .useValue(permissionsGuard)
      .overrideProvider(PrismaService)
      .useValue(doubles.prisma)
      .overrideProvider(CacheService)
      .useValue(doubles.cache)
      .overrideProvider(RedisService)
      .useValue(doubles.redis)
      .overrideProvider(authConfig.KEY)
      .useValue(TEST_AUTH_CONFIG)
      .compile();

    app = moduleFixture.createNestApplication();
    await configureApp(app, { webUrl: TEST_WEB_URL, nodeEnv: 'test' });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function http() {
    if (!app) {
      throw new Error('Test application is not initialized');
    }
    return request(app.getHttpServer());
  }

  it('uses the configured API prefix and returns a safe public health response', async () => {
    await http().get('/').expect(404);
    await http().get('/api/v1/').expect(404);

    const response = await http().get('/api/v1/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      info: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
      error: {},
      details: {
        database: { status: 'up' },
        redis: { status: 'up' },
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('Hello World!');
    expect(JSON.stringify(response.body)).not.toMatch(
      /DATABASE_URL|REDIS_URL|password|secret/i,
    );
  });

  it('preserves only safe dependency statuses when health is unavailable', async () => {
    doubles.redis.ping.mockResolvedValue(false);

    const response = await http().get('/api/v1/health').expect(503);

    expect(response.body).toMatchObject({
      statusCode: 503,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      details: {
        health: {
          status: 'error',
          error: { redis: { status: 'down' } },
          details: { redis: { status: 'down' } },
        },
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /DATABASE_URL|REDIS_URL|password|secret|responseTime/i,
    );
  });

  it('registers, resends, confirms, and then allows the new user to log in', async () => {
    if (!app) {
      throw new Error('Test application is not initialized');
    }

    const agent = request.agent(app.getHttpServer());
    const register = await agent
      .post('/api/v1/auth/register')
      .send({
        email: 'new@example.com',
        displayName: 'New User',
        password: TEST_PASSWORD,
        confirmPassword: TEST_PASSWORD,
      })
      .expect(201);

    expect(register.body).toEqual({
      status: 'CONFIRMATION_REQUIRED',
      email: 'new@example.com',
      destination: 'n***@example.com',
    });
    expect(register.headers['set-cookie']).toBeUndefined();
    expectSafeJson(register.body);

    const resend = await agent
      .post('/api/v1/auth/register/resend-code')
      .send({ email: 'new@example.com' })
      .expect(201);
    expect(resend.body).toEqual(register.body);
    expect(resend.headers['set-cookie']).toBeUndefined();

    const confirmation = await agent
      .post('/api/v1/auth/register/confirm')
      .send({ email: 'new@example.com', confirmationCode: '123456' })
      .expect(201);
    expect(confirmation.body).toEqual({ status: 'CONFIRMED' });
    expect(confirmation.headers['set-cookie']).toBeUndefined();
    expectSafeJson(confirmation.body);

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'new@example.com', password: TEST_PASSWORD })
      .expect(201);
    expect(login.body.user.email).toBe('new@example.com');
    expectSetCookieAttributes(cookieHeaders(login), 'access_token', '900');
  });

  it('logs in with safe JSON, sets protected cookies, and serves empty organizations', async () => {
    if (!app) {
      throw new Error('Test application is not initialized');
    }

    const admin = request.agent(app.getHttpServer());
    const login = await admin
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: TEST_PASSWORD })
      .expect(201);

    expect(login.body).toEqual({
      user: {
        id: 'user-admin',
        email: 'admin@example.com',
        displayName: 'Admin User',
      },
    });
    expectSafeJson(login.body);

    const loginCookies = cookieHeaders(login);
    expectSetCookieAttributes(loginCookies, 'access_token', '900');
    expectSetCookieAttributes(loginCookies, 'refresh_token', '2592000');
    expectSetCookieAttributes(loginCookies, 'cognito_username', '2592000');

    const me = await admin.get('/api/v1/me').expect(200);
    expect(me.body).toEqual({
      user: {
        id: 'user-admin',
        email: 'admin@example.com',
        displayName: 'Admin User',
      },
      organizations: [
        {
          id: 'organization-one',
          name: 'Organization One',
          slug: 'organization-one',
          role: 'ADMIN',
        },
      ],
    });
    expectSafeJson(me.body);

    const noMembership = request.agent(app.getHttpServer());
    await noMembership
      .post('/api/v1/auth/login')
      .send({ email: 'empty@example.com', password: TEST_PASSWORD })
      .expect(201);
    const emptyOrganizations = await noMembership.get('/api/v1/me').expect(200);
    expect(emptyOrganizations.body.organizations).toEqual([]);
    expectSafeJson(emptyOrganizations.body);
  });

  it('replaces refresh cookies and clears all auth cookies on logout', async () => {
    if (!app) {
      throw new Error('Test application is not initialized');
    }

    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: TEST_PASSWORD })
      .expect(201);
    const initialCookies = cookieHeaders(login);
    const initialAccessToken = cookieValue(initialCookies, 'access_token');
    const initialRefreshToken = cookieValue(initialCookies, 'refresh_token');

    const refresh = await agent.post('/api/v1/auth/refresh').expect(201);
    const refreshedCookies = cookieHeaders(refresh);
    expect(cookieValue(refreshedCookies, 'access_token')).not.toBe(
      initialAccessToken,
    );
    expect(cookieValue(refreshedCookies, 'refresh_token')).not.toBe(
      initialRefreshToken,
    );
    expectSetCookieAttributes(refreshedCookies, 'access_token', '900');
    expectSetCookieAttributes(refreshedCookies, 'refresh_token', '2592000');
    expect(doubles.cognito.refreshToken).toHaveBeenCalledWith(
      initialRefreshToken,
      'admin@example.com',
    );
    expectSafeJson(refresh.body);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [
        `refresh_token=${initialRefreshToken}`,
        'cognito_username=admin@example.com',
      ])
      .expect(401);

    const refreshedRefreshToken = cookieValue(
      refreshedCookies,
      'refresh_token',
    );
    const logout = await agent.post('/api/v1/auth/logout').expect(201);
    const clearedCookies = cookieHeaders(logout);
    expectClearedCookieAttributes(clearedCookies, 'access_token');
    expectClearedCookieAttributes(clearedCookies, 'refresh_token');
    expectClearedCookieAttributes(clearedCookies, 'cognito_username');
    expect(doubles.cognito.revokeToken).toHaveBeenCalledWith(
      cookieValue(refreshedCookies, 'refresh_token'),
    );
    expectSafeJson(logout.body);

    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .set('Cookie', [
        `refresh_token=${refreshedRefreshToken}`,
        'cognito_username=admin@example.com',
      ])
      .expect(401);
    await agent.get('/api/v1/me').expect(401);
  });

  it('enforces organization scope and role-specific organization/member permissions', async () => {
    if (!app) {
      throw new Error('Test application is not initialized');
    }

    const admin = request.agent(app.getHttpServer());
    await admin
      .post('/api/v1/auth/login')
      .send({ email: 'admin@example.com', password: TEST_PASSWORD })
      .expect(201);

    await admin
      .get('/api/v1/organizations/organization-one')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          id: 'organization-one',
          name: 'Organization One',
          slug: 'organization-one',
        });
      });
    await admin
      .patch('/api/v1/organizations/organization-one')
      .send({ name: 'Updated Organization One' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual({
          id: 'organization-one',
          name: 'Updated Organization One',
          slug: 'organization-one',
        });
      });

    await admin
      .get('/api/v1/organizations/organization-one/members')
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              userId: 'user-admin',
              role: 'ADMIN',
            }),
          ]),
        );
      });
    await admin
      .post('/api/v1/organizations/organization-one/members')
      .send({ userId: 'user-empty', role: 'VIEWER' })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ userId: 'user-empty', role: 'VIEWER' });
      });
    await admin
      .patch('/api/v1/organizations/organization-one/members/user-empty')
      .send({ role: 'OPERATOR' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({ userId: 'user-empty', role: 'OPERATOR' });
      });
    await admin
      .delete('/api/v1/organizations/organization-one/members/user-empty')
      .expect(204);

    const viewer = request.agent(app.getHttpServer());
    await viewer
      .post('/api/v1/auth/login')
      .send({ email: 'viewer@example.com', password: TEST_PASSWORD })
      .expect(201);

    await viewer.get('/api/v1/organizations/organization-one').expect(200);
    await viewer
      .get('/api/v1/organizations/organization-one/members')
      .expect(200);
    await viewer
      .patch('/api/v1/organizations/organization-one')
      .send({ name: 'Viewer Must Not Update' })
      .expect(403);
    await viewer
      .post('/api/v1/organizations/organization-one/members')
      .send({ userId: 'user-empty', role: 'VIEWER' })
      .expect(403);
    await viewer
      .patch('/api/v1/organizations/organization-one/members/user-operator')
      .send({ role: 'VIEWER' })
      .expect(403);
    await viewer
      .delete('/api/v1/organizations/organization-one/members/user-operator')
      .expect(403);
    await viewer
      .get('/api/v1/organizations/organization-two/members')
      .expect(404);

    const operator = request.agent(app.getHttpServer());
    await operator
      .post('/api/v1/auth/login')
      .send({ email: 'operator@example.com', password: TEST_PASSWORD })
      .expect(201);
    await operator.get('/api/v1/organizations/organization-one').expect(200);
    await operator
      .get('/api/v1/organizations/organization-one/members')
      .expect(200);
    await operator
      .patch('/api/v1/organizations/organization-one')
      .send({ name: 'Operator Must Not Update' })
      .expect(403);
    await operator
      .post('/api/v1/organizations/organization-one/members')
      .send({ userId: 'user-empty', role: 'VIEWER' })
      .expect(403);

    await viewer.get('/api/v1/organizations/organization-two').expect(404);
  });
});
