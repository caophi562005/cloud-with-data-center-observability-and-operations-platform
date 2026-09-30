# CloudOps Phase 1 Identity, Organization & RBAC Implementation Plan

> **For the agent executing this plan:** Required sub-skill: use `superpower-subagent-driven-development` (recommended) or `superpower-executing-plans` to execute this plan task by task. Steps use checkbox syntax for tracking. The user has explicitly prohibited `git add`, `git commit`, merge commits, cherry-picks, and equivalent staging operations until the user reviews the complete uncommitted changes and explicitly authorizes them.

**Goal:** Implement the Phase 1 full vertical slice: NestJS/Cognito authentication, Prisma/Neon identity data, Redis cache, tenant RBAC, secure cookies, and a React/TanStack Query client using the existing OpsGrid dashboard.

**Architecture:** Keep the existing modular-monolith direction. The NestJS API owns authentication, Cognito integration, local identity, organization membership, permission checks, and safe HTTP responses. React uses a feature-first structure and TanStack Query for server state; it never sees Cognito tokens. The existing Terraform Cognito module remains the infrastructure source of truth and is validated rather than redesigned.

**Technology:** NestJS 12, React 19, Vite, TypeScript, Prisma, Neon PostgreSQL, Redis, AWS Cognito `USER_PASSWORD_AUTH`, `@aws-sdk/client-cognito-identity-provider`, `aws-jwt-verify`, Zod, `@nestjs/throttler`, `nestjs-pino`, TanStack Query, Terraform AWS provider 6.x, Vitest, Supertest, Oxlint, Prettier.

**Specification:** `docs/superpowers/specs/2026-09-30-cloudops-phase1-identity-design.md`

## Global constraints

- Preserve the custom React login form → NestJS BFF → Cognito `USER_PASSWORD_AUTH` flow.
- React never calls Cognito directly, parses JWTs, stores tokens, or receives raw Cognito tokens in JSON.
- API authorization uses a verified Cognito access token from an HttpOnly cookie; an ID token is never the API authorization credential.
- Support `SECRET_HASH` when `COGNITO_CLIENT_SECRET` exists and omit it when the client is public.
- The current Terraform client is confidential with `generate_secret = true`; its existing `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` settings must be verified.
- Resolve local users by unique `cognitoSub`; do not use email as the immutable identity key.
- A first login may create a local `User` but never automatically creates a membership or grants `ADMIN`.
- Users without memberships remain authenticated and receive `organizations: []` from `/api/v1/me`.
- Role belongs to `Membership`: `ADMIN`, `OPERATOR`, or `VIEWER`.
- Do not store passwords, Cognito access/ID/refresh tokens, client secrets, database URLs, or Redis URLs in PostgreSQL, Redis, logs, fixtures, or responses.
- Redis is a cache and fallback dependency, not an application session store.
- Use Redis cache invalidation after organization and membership mutations; authorization falls back to PostgreSQL when Redis is unavailable.
- Use Zod validation; do not introduce `class-validator` or duplicate validation systems.
- Use `@tanstack/react-query` for React server state; do not add Zustand.
- Keep the existing `/` → `/dashboard` redirect and OpsGrid branding.
- Do not create empty future-phase directories or Phase 2 features.
- No `git add`, `git commit`, merge, cherry-pick, or equivalent staging operation is permitted during execution. Leave all implementation changes uncommitted for user review.
- Do not claim AWS, Neon, or Redis integration success without an actual successful command result.

---

## File and responsibility map

### API files

Create:

```text
apps/api/.env.example
apps/api/prisma/schema.prisma
apps/api/prisma/seed.ts
apps/api/prisma.config.ts
the Prisma-generated `phase1_identity` migration under `apps/api/prisma/migrations/`
apps/api/src/config/app.config.ts
apps/api/src/config/auth.config.ts
apps/api/src/config/database.config.ts
apps/api/src/config/redis.config.ts
apps/api/src/config/env.schema.ts
apps/api/src/config/index.ts
apps/api/src/common/constants/auth.constants.ts
apps/api/src/common/decorators/current-user.decorator.ts
apps/api/src/common/decorators/current-organization.decorator.ts
apps/api/src/common/decorators/public.decorator.ts
apps/api/src/common/decorators/require-permissions.decorator.ts
apps/api/src/common/filters/http-exception.filter.ts
apps/api/src/common/guards/csrf-origin.guard.ts
apps/api/src/common/interceptors/request-id.interceptor.ts
apps/api/src/common/pipes/zod-validation.pipe.ts
apps/api/src/common/types/authenticated-user.type.ts
apps/api/src/common/types/request-context.type.ts
apps/api/src/common/types/api-error.type.ts
apps/api/src/infrastructure/database/prisma/prisma.module.ts
apps/api/src/infrastructure/database/prisma/prisma.service.ts
apps/api/src/infrastructure/cache/redis.module.ts
apps/api/src/infrastructure/cache/redis.service.ts
apps/api/src/infrastructure/cache/cache.service.ts
apps/api/src/infrastructure/aws/cognito/cognito.module.ts
apps/api/src/infrastructure/aws/cognito/cognito.service.ts
apps/api/src/infrastructure/aws/cognito/cognito-token-verifier.service.ts
apps/api/src/infrastructure/aws/cognito/cognito-secret-hash.service.ts
apps/api/src/infrastructure/aws/cognito/cognito.types.ts
apps/api/src/infrastructure/aws/cognito/cognito.constants.ts
apps/api/src/modules/auth/auth.module.ts
apps/api/src/modules/auth/auth.controller.ts
apps/api/src/modules/auth/auth.service.ts
apps/api/src/modules/auth/auth-cookie.service.ts
apps/api/src/modules/auth/schemas/login.schema.ts
apps/api/src/modules/auth/guards/cognito-auth.guard.ts
apps/api/src/modules/users/users.module.ts
apps/api/src/modules/users/users.service.ts
apps/api/src/modules/users/users.repository.ts
apps/api/src/modules/organizations/organizations.module.ts
apps/api/src/modules/organizations/organizations.controller.ts
apps/api/src/modules/organizations/organizations.service.ts
apps/api/src/modules/organizations/organizations.repository.ts
apps/api/src/modules/organizations/schemas/organization.schema.ts
apps/api/src/modules/memberships/memberships.module.ts
apps/api/src/modules/memberships/memberships.controller.ts
apps/api/src/modules/memberships/memberships.service.ts
apps/api/src/modules/memberships/memberships.repository.ts
apps/api/src/modules/memberships/schemas/membership.schema.ts
apps/api/src/modules/authorization/authorization.module.ts
apps/api/src/modules/authorization/authorization.service.ts
apps/api/src/modules/authorization/permissions.ts
apps/api/src/modules/authorization/role-permissions.ts
apps/api/src/modules/authorization/guards/permissions.guard.ts
apps/api/src/modules/health/health.module.ts
apps/api/src/modules/health/health.controller.ts
apps/api/src/modules/health/indicators/database.health-indicator.ts
apps/api/src/modules/health/indicators/redis.health-indicator.ts
```

Modify:

```text
apps/api/package.json
apps/api/src/main.ts
apps/api/src/app.module.ts
apps/api/.env  # only add missing non-secret local values; never overwrite existing secrets
apps/api/src/app.controller.spec.ts
apps/api/test/app.e2e-spec.ts
```

Add focused tests beside the implementation using the existing `*.spec.ts` convention. Do not introduce a second test runner.

### Web files

Create only files required by the implementation:

```text
apps/web/src/app/providers/query-provider.tsx
apps/web/src/app/router/protected-route.tsx
apps/web/src/features/auth/api/auth.api.ts
apps/web/src/features/auth/auth.types.ts
apps/web/src/features/auth/auth.schema.ts
apps/web/src/features/auth/hooks/use-auth.ts
apps/web/src/features/auth/components/auth-layout.tsx
apps/web/src/features/auth/components/auth-brand-panel.tsx
apps/web/src/features/auth/components/login-form.tsx
apps/web/src/features/auth/pages/login-page.tsx
apps/web/src/features/organizations/api/organizations.api.ts
apps/web/src/features/organizations/hooks/use-organizations.ts
apps/web/src/features/memberships/api/memberships.api.ts
apps/web/src/features/memberships/hooks/use-members.ts
apps/web/src/lib/api/api-error.ts
apps/web/src/lib/api/http-client.ts
apps/web/src/lib/query/query-client.ts
apps/web/src/lib/query/query-keys.ts
apps/web/src/types/api.ts
```

Modify:

```text
apps/web/src/app/providers/app-providers.tsx
apps/web/src/app/router/router.tsx
apps/web/src/app/layouts/app-layout.tsx        # only if the protected route boundary requires it
apps/web/src/features/dashboard/pages/dashboard-page.tsx
apps/web/src/components/shell/tenant-switcher.tsx
apps/web/src/components/shell/user-menu.tsx
apps/web/src/types/domain.ts
apps/web/src/index.css                          # only for auth/no-organization states if needed
apps/web/vite.config.ts
```

Remove or stop importing mock current-user, organization, and member records once API data is wired. Keep UI-only checklist data if it has no server source. Do not create test files in `apps/web` unless the existing package is explicitly extended with a web test runner in a later approved scope.

---

## Task 1: Add API dependencies, scripts, and validated configuration

**Files:**

- Modify: `apps/api/package.json`
- Create: `apps/api/.env.example`
- Create: `apps/api/src/config/env.schema.ts`
- Create: `apps/api/src/config/app.config.ts`
- Create: `apps/api/src/config/auth.config.ts`
- Create: `apps/api/src/config/database.config.ts`
- Create: `apps/api/src/config/redis.config.ts`
- Create: `apps/api/src/config/index.ts`
- Test: `apps/api/src/config/env.schema.spec.ts`

**Interfaces:**

- `envSchema: z.ZodType` parses `NODE_ENV`, `PORT`, `WEB_URL`, `DATABASE_URL`, `REDIS_URL`, `COGNITO_REGION`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and optional `COGNITO_CLIENT_SECRET`.
- `AppConfig`, `AuthConfig`, `DatabaseConfig`, and `RedisConfig` expose typed values to Nest configuration factories.
- Add scripts: `typecheck`, `format:check`, `prisma:generate`, `prisma:migrate:dev`, `prisma:migrate:deploy`, and `prisma:seed`.

- [ ] **Step 1: Add only the required packages.**

Run from the repository root:

```powershell
pnpm --dir apps/api add @nestjs/config @nestjs/swagger @nestjs/throttler @nestjs/terminus @aws-sdk/client-cognito-identity-provider aws-jwt-verify @prisma/client @prisma/adapter-pg pg zod cookie-parser helmet redis nestjs-pino pino-http
pnpm --dir apps/api add -D prisma @types/cookie-parser @types/pg tsx dotenv
```

Remove the unused `@nestjs/observe` dependency only if the placeholder module is removed in Task 9. Verify the installed Nest package majors match the existing Nest 12 dependencies before proceeding. Do not add Passport, JWT-signing, password-hashing, or AWS static-credential packages.

- [ ] **Step 2: Add reproducible package scripts.**

Update the API scripts without removing the existing build, lint, test, and start commands:

```json
{
  "typecheck": "tsc --noEmit",
  "format:check": "prettier --check \"src/**/*.ts\" \"test/**/*.ts\" \"prisma/**/*.ts\"",
  "prisma:generate": "prisma generate",
  "prisma:migrate:dev": "prisma migrate dev",
  "prisma:migrate:deploy": "prisma migrate deploy",
  "prisma:seed": "prisma db seed"
}
```

Create `apps/api/prisma.config.ts` with `import 'dotenv/config'` and Prisma 7 `defineConfig`/`env`: use `schema: 'prisma/schema.prisma'`, `migrations.path: 'prisma/migrations'`, `migrations.seed: 'tsx prisma/seed.ts'`, and `datasource.url: env('DATABASE_URL')`. This keeps the ignored local `.env` workflow working for Prisma CLI commands.

- [ ] **Step 3: Write failing environment tests first.**

Create tests covering valid development values, missing required values, invalid URLs, invalid Cognito identifiers, and optional client secret behavior:

```ts
it('accepts the local API configuration', () => {
  expect(envSchema.parse({
    NODE_ENV: 'development',
    PORT: '3000',
    WEB_URL: 'http://localhost:5173',
    DATABASE_URL: 'postgresql://user:password@host/db?sslmode=require',
    REDIS_URL: 'redis://default:password@localhost:6379',
    COGNITO_REGION: 'ap-southeast-1',
    COGNITO_USER_POOL_ID: 'ap-southeast-1_example',
    COGNITO_CLIENT_ID: 'exampleclientid',
  }).PORT).toBe(3000);
});

it('rejects a missing Redis URL', () => {
  expect(() => envSchema.parse(validEnvWithout('REDIS_URL'))).toThrow();
});
```

- [ ] **Step 4: Run the focused test and confirm it fails.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/config/env.schema.spec.ts
```

Expected result: FAIL because the schema and configuration files do not exist.

- [ ] **Step 5: Implement the Zod schema and config factories.**

Use strict parsing and transform `PORT` from string to number. Validate `NODE_ENV` as `development | test | production`, `WEB_URL`/database/Redis as URLs accepted by their providers, Cognito region as a non-empty AWS region string, pool ID as `<region>_<identifier>`, and client ID as a non-empty string. Keep `COGNITO_CLIENT_SECRET` optional at schema level.

- [ ] **Step 6: Add the safe `.env.example` and local non-secret defaults.**

Create `.env.example` with placeholders only and add missing `NODE_ENV=development`, `PORT=3000`, and `WEB_URL=http://localhost:5173` to the ignored local `.env` without changing existing database, Redis, or Cognito values. Add the optional commented `SEED_ADMIN_COGNITO_SUB` entry only to `.env.example`.

- [ ] **Step 7: Run configuration tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/config/env.schema.spec.ts
pnpm --dir apps/api typecheck
```

Expected result: PASS for the focused tests and typecheck. Do not stage or commit.

---

## Task 2: Define Prisma models, migration, and explicit seed behavior

**Files:**

- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/seed.ts`
- Create: `the Prisma-generated `phase1_identity` migration under `apps/api/prisma/migrations/``
- Modify: `apps/api/package.json` only if Prisma configuration requires it

**Interfaces:**

- Prisma enum `Role = ADMIN | OPERATOR | VIEWER`.
- Models `User`, `Organization`, and `Membership` use UUID IDs, unique `User.cognitoSub`, unique `Organization.slug`, and `@@unique([userId, organizationId])`.
- Seed creates the demo organization and only assigns `ADMIN` when `SEED_ADMIN_COGNITO_SUB` identifies an existing synchronized user.

- [ ] **Step 1: Write the schema file from the approved design.**

Use the exact model contract from the specification, including:

```prisma
enum Role {
  ADMIN
  OPERATOR
  VIEWER
}

model User {
  id          String       @id @default(uuid()) @db.Uuid
  cognitoSub  String       @unique
  email       String
  displayName String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]

  @@index([email])
}
```

Add the specified Organization and Membership relations, cascade behavior, composite unique constraint, and lookup indexes. Do not add password, token, secret, or Cognito-group fields.

- [ ] **Step 2: Generate the client and validate the schema.**

Run:

```powershell
pnpm --dir apps/api prisma:generate
pnpm --dir apps/api exec prisma validate
```

Expected result: Prisma generates the client and reports a valid schema.

- [ ] **Step 3: Create the development migration.**

Run with the configured database URL:

```powershell
pnpm --dir apps/api prisma:migrate:dev --name phase1_identity
```

If the command cannot reach Neon, create no fake migration result; report the exact connection failure and use `prisma migrate diff`/schema validation only for local structural verification. The migration must create the enum, three tables, unique constraints, indexes, timestamps, and cascade foreign keys.

- [ ] **Step 4: Implement the seed without automatic admin assignment.**

Implement `prisma/seed.ts` so it:

1. Connects through Prisma.
2. Upserts the demo organization by slug.
3. Reads `SEED_ADMIN_COGNITO_SUB`.
4. If it is absent, exits successfully after the organization upsert.
5. If present, finds the existing user by `cognitoSub` and upserts an `ADMIN` membership.
6. If the user is absent, throws an actionable error and does not create a user from an email.
7. Disconnects Prisma in `finally`.

- [ ] **Step 5: Validate seed compilation without seeding a fake admin.**

Run:

```powershell
pnpm --dir apps/api typecheck
pnpm --dir apps/api prisma:generate
```

Expected result: PASS. Do not set a fake `SEED_ADMIN_COGNITO_SUB` and do not claim the remote seed ran unless `prisma db seed` actually succeeds.

---

## Task 3: Build Prisma infrastructure and application repositories

**Files:**

- Create: `apps/api/src/infrastructure/database/prisma/prisma.module.ts`
- Create: `apps/api/src/infrastructure/database/prisma/prisma.service.ts`
- Create/modify user, organization, and membership repository/service files from the file map
- Tests: `users.service.spec.ts`, `organizations.service.spec.ts`, `memberships.service.spec.ts`

**Interfaces:**

```ts
interface UsersService {
  findByCognitoSub(cognitoSub: string): Promise<LocalUser | null>;
  upsertFromCognito(input: { cognitoSub: string; email: string; displayName?: string }): Promise<LocalUser>;
}

interface OrganizationsService {
  findForUser(userId: string): Promise<OrganizationWithRole[]>;
  getById(organizationId: string): Promise<OrganizationSummary>;
  update(organizationId: string, input: OrganizationUpdateInput): Promise<OrganizationSummary>;
}

interface MembershipsService {
  list(organizationId: string): Promise<MemberSummary[]>;
  create(organizationId: string, input: { userId: string; role: Role }): Promise<MemberSummary>;
  updateRole(organizationId: string, userId: string, role: Role): Promise<MemberSummary>;
  remove(organizationId: string, userId: string): Promise<void>;
}
```

Prisma 7.10.0 requires a runtime driver adapter; use `@prisma/adapter-pg` with `pg` and construct `PrismaClient({ adapter })` from the configured `DATABASE_URL`. `PrismaModule` remains global and owns connect/disconnect lifecycle. Tests mock `PrismaService` and never connect to Neon.

- [ ] **Step 1: Write repository/service tests with Prisma mocked.**

Cover `findByCognitoSub`, Cognito-sub upsert, organization membership projection, duplicate membership rejection mapping, member role update, and member deletion. Assert that repository calls use `cognitoSub` for identity resolution and never accept a password/token field.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/users src/modules/organizations src/modules/memberships
```

Expected result: FAIL because modules and services are not implemented.

- [ ] **Step 3: Implement PrismaService lifecycle.**

Extend `PrismaClient`, connect in `onModuleInit`, and register Nest shutdown hooks in `onModuleInit` or module bootstrap. Disconnect in `onModuleDestroy`. Export the service from a global `PrismaModule` so feature modules inject it without direct controller queries.

- [ ] **Step 4: Implement repositories with typed projections.**

Use explicit `select` objects for safe user, organization, and membership responses. Never return `password`, token, Cognito raw claims, or secret fields because no such fields exist in the schema. Keep query composition inside repositories.

- [ ] **Step 5: Implement services and conflict mapping.**

Wrap Prisma unique-constraint failures into application conflict errors with stable codes. Use transactions for membership changes where invalidation and the database mutation must be ordered. Keep email as a secondary lookup only.

- [ ] **Step 6: Run focused tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/users src/modules/organizations src/modules/memberships
pnpm --dir apps/api typecheck
```

Expected result: PASS. Do not stage or commit.

---

## Task 4: Implement Redis infrastructure and cache abstraction

**Files:**

- Create: `apps/api/src/infrastructure/cache/redis.module.ts`
- Create: `apps/api/src/infrastructure/cache/redis.service.ts`
- Create: `apps/api/src/infrastructure/cache/cache.service.ts`
- Tests: `redis.service.spec.ts`, `cache.service.spec.ts`

**Interfaces:**

```ts
interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(...keys: string[]): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}
```

- [ ] **Step 1: Write cache tests first.**

Test JSON serialization/deserialization, TTL forwarding, deletion, prefix invalidation, Redis errors returning cache misses, and mutation invalidation not throwing when Redis is unavailable.

```ts
it('returns a typed cached value', async () => {
  redisMock.get.mockResolvedValue(JSON.stringify({ role: 'ADMIN' }));
  await expect(cache.get<{ role: string }>('key')).resolves.toEqual({ role: 'ADMIN' });
});

it('falls back on Redis read failure', async () => {
  redisMock.get.mockRejectedValue(new Error('connection refused'));
  await expect(cache.get('key')).resolves.toBeNull();
});
```

- [ ] **Step 2: Run focused tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/infrastructure/cache
```

Expected result: FAIL because the cache classes do not exist.

- [ ] **Step 3: Implement RedisService.**

Create a `redis` client from `REDIS_URL`, connect once during module initialization, expose a health/ping method, and quit gracefully during module destruction. Do not log the URL or connection options containing credentials.

- [ ] **Step 4: Implement CacheService.**

Serialize safe JSON values, apply `EX` TTLs, catch and redact Redis errors, and return `null` on read failure. Implement prefix invalidation with `SCAN` rather than blocking `KEYS`. Use the namespace keys from the specification.

- [ ] **Step 5: Run cache tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/infrastructure/cache
pnpm --dir apps/api typecheck
```

Expected result: PASS without requiring a hosted Redis connection.

---

## Task 5: Implement Cognito command adapter, secret hash, and token verification

**Files:**

- Create: `apps/api/src/infrastructure/aws/cognito/cognito.module.ts`
- Create: `cognito.service.ts`, `cognito-token-verifier.service.ts`, `cognito-secret-hash.service.ts`, `cognito.types.ts`, `cognito.constants.ts`
- Tests: `cognito-secret-hash.service.spec.ts`, `cognito.service.spec.ts`, `cognito-token-verifier.service.spec.ts`

**Interfaces:**

```ts
type CognitoAuthenticationResult = {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
};

interface CognitoService {
  signInWithPassword(email: string, password: string): Promise<CognitoAuthenticationResult>;
  refreshToken(refreshToken: string, username?: string): Promise<CognitoAuthenticationResult>;
  revokeToken(refreshToken: string): Promise<void>;
}
```

- [ ] **Step 1: Write secret-hash test vectors.**

Use a fixed non-secret test client ID, username, and test secret. Assert the Base64 HMAC-SHA256 output against a locally calculated known value, and assert that an absent client secret returns `undefined`.

- [ ] **Step 2: Write Cognito command tests.**

Mock `CognitoIdentityProviderClient.send` and assert:

```ts
expect(command.input.AuthFlow).toBe('USER_PASSWORD_AUTH');
expect(command.input.AuthParameters).toMatchObject({
  USERNAME: 'admin@example.com',
  PASSWORD: 'password',
  SECRET_HASH: expectedHash,
});
```

Add a public-client test asserting `SECRET_HASH` is omitted. Add refresh tests asserting `REFRESH_TOKEN_AUTH`, `REFRESH_TOKEN`, and conditional username/hash behavior. Assert raw command results are mapped to the internal result type.

- [ ] **Step 3: Run Cognito tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/infrastructure/aws/cognito
```

Expected result: FAIL because the adapter files do not exist.

- [ ] **Step 4: Implement CognitoSecretHashService.**

Calculate `HMAC-SHA256(username + clientId, clientSecret)` and encode the digest as Base64. Never log arguments or output. Return no value when no client secret exists.

- [ ] **Step 5: Implement CognitoService with AWS SDK commands.**

Use `InitiateAuthCommand` for password and refresh flows and `RevokeTokenCommand` for logout. Pass `ClientId` from config. Add `SECRET_HASH` only when the secret exists. Translate SDK results into `CognitoAuthenticationResult` without logging tokens.

- [ ] **Step 6: Implement token verification.**

Create access and ID `CognitoJwtVerifier` instances with the configured user pool and client ID. Access verification requires `token_use = access`; ID verification requires `token_use = id`. Expose typed verified claims and map verifier failures to a safe unauthorized error. Unit tests must mock verifier calls so no JWKS network is used.

- [ ] **Step 7: Run tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/infrastructure/aws/cognito
pnpm --dir apps/api typecheck
```

Expected result: PASS.

---

## Task 6: Add common HTTP types, Zod pipes, cookies, and safe errors

**Files:**

- Create common decorator/filter/pipe/type files from the file map.
- Create: `apps/api/src/modules/auth/auth-cookie.service.ts`
- Create: `apps/api/src/modules/auth/schemas/login.schema.ts`
- Tests: `zod-validation.pipe.spec.ts`, `http-exception.filter.spec.ts`, `auth-cookie.service.spec.ts`

**Interfaces:**

```ts
type AuthenticatedUser = {
  cognitoSub: string;
  clientId: string;
  scope?: string;
  tokenUse: 'access';
};

interface AuthCookieService {
  setAccessToken(response: Response, token: string): void;
  setRefreshToken(response: Response, token: string): void;
  setCognitoUsername(response: Response, username: string): void;
  clearAccessToken(response: Response): void;
  clearRefreshToken(response: Response): void;
  clearAuthCookies(response: Response): void;
}
```

- [ ] **Step 1: Write cookie and error tests first.**

Assert HttpOnly, `Path=/`, development `Secure=false`, production `Secure=true`, configured SameSite, separate max-age values, and clearing of access/refresh/username cookies. Assert the exception filter returns stable `{ statusCode, code, message }` without stack, AWS request ID, or exception internals.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/common src/modules/auth/auth-cookie.service.spec.ts
```

Expected result: FAIL because the files are not implemented.

- [ ] **Step 3: Implement ZodValidationPipe and request decorators.**

The pipe accepts a Zod schema, parses the input, and throws a safe validation exception with field issues. Implement `CurrentUser`, `CurrentOrganization`, `Public`, and `RequirePermissions` decorators with typed metadata.

- [ ] **Step 4: Implement AuthCookieService.**

Centralize all cookie names/options in `auth.constants.ts` and config. The username cookie is HttpOnly and cleared with the other auth cookies; it is never returned to React. Do not set cookies from controllers.

- [ ] **Step 5: Implement HttpExceptionFilter.**

Map validation, authentication, authorization, conflict, rate-limit, and unknown errors to stable application codes. Include the request ID in logs, not secret request data. Return stack traces only to server logs in development, never in response JSON.

- [ ] **Step 6: Run tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/common src/modules/auth/auth-cookie.service.spec.ts
pnpm --dir apps/api typecheck
```

Expected result: PASS.

---

## Task 7: Implement AuthService, auth controller, access guard, and `/me`

**Files:**

- Create/modify: `apps/api/src/modules/auth/auth.module.ts`
- Create: `auth.controller.ts`, `auth.service.ts`, `guards/cognito-auth.guard.ts`
- Modify: `users.service.ts` where synchronization is owned
- Tests: `auth.service.spec.ts`, `cognito-auth.guard.spec.ts`, `auth.controller.spec.ts`

**Interfaces:**

```ts
interface AuthService {
  login(input: LoginInput, response: Response): Promise<SafeSessionResponse>;
  refresh(request: Request, response: Response): Promise<SafeSessionResponse>;
  logout(request: Request, response: Response): Promise<void>;
  getCurrentSession(principal: AuthenticatedUser): Promise<MeResponse>;
}
```

- [ ] **Step 1: Write AuthService tests first.**

Test successful login command/result mapping, access and ID verification, upsert by Cognito `sub`, cookie calls, safe response shape, no-membership response, invalid credentials mapping, refresh with username cookie and conditional hash, refresh-token rotation, missing-cookie cleanup, and logout cleanup when revoke throws.

- [ ] **Step 2: Run focused tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/auth
```

Expected result: FAIL because the service/controller/guard are not implemented.

- [ ] **Step 3: Implement login.**

The controller accepts only the Zod-validated email/password body. `AuthService.login` calls `CognitoService.signInWithPassword`, verifies the access token and ID token, upserts the local user with `cognitoSub`, email, and name, sets access/refresh/username cookies, and returns only the safe user object.

Never pass the password to Prisma, logs, cache, or another service after the Cognito command is built.

- [ ] **Step 4: Implement CognitoAuthGuard.**

Read only the configured access cookie, verify it with the access verifier, map claims to `AuthenticatedUser`, and attach the principal to the request. Missing or invalid cookies return a safe 401. Do not accept an ID token or browser-supplied organization role.

- [ ] **Step 5: Implement refresh and logout.**

Refresh reads the refresh and username cookies, invokes `REFRESH_TOKEN_AUTH`, verifies the new access token, replaces access and optional refresh cookies, and returns a safe user response. Logout attempts remote revoke, clears all cookies in a `finally` path, and never exposes revoke failure details.

- [ ] **Step 6: Implement `/api/v1/me`.**

The protected endpoint resolves the local user by verified `cognitoSub`, loads membership organizations, applies the `me` cache key, and returns the exact safe response. A local user with no memberships receives an empty array.

- [ ] **Step 7: Run auth tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/auth
pnpm --dir apps/api typecheck
```

Expected result: PASS.

---

## Task 8: Implement centralized authorization and tenant endpoints

**Files:**

- Create: `apps/api/src/modules/authorization/*`
- Complete: organizations and memberships controllers/services/repositories/schemas
- Tests: `authorization.service.spec.ts`, `permissions.guard.spec.ts`, organization/membership controller tests

**Interfaces:**

```ts
type Permission =
  | 'profile.read'
  | 'organization.read'
  | 'organization.update'
  | 'member.read'
  | 'member.manage';

interface AuthorizationService {
  getMembership(userId: string, organizationId: string): Promise<MembershipContext | null>;
  requirePermission(userId: string, organizationId: string, permission: Permission): Promise<MembershipContext>;
}
```

- [ ] **Step 1: Write permission-matrix tests first.**

Assert the exact matrix:

```ts
expect(rolePermissions.ADMIN).toEqual(expect.arrayContaining([
  'profile.read', 'organization.read', 'organization.update', 'member.read', 'member.manage',
]));
expect(rolePermissions.OPERATOR).toEqual([
  'profile.read', 'organization.read', 'member.read',
]);
expect(rolePermissions.VIEWER).toEqual([
  'profile.read', 'organization.read', 'member.read',
]);
```

Add guard tests for missing membership, insufficient permission, and successful tenant access. Include a test proving a user cannot use another organization ID without a membership.

- [ ] **Step 2: Run tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/authorization
```

Expected result: FAIL because the permission module is not implemented.

- [ ] **Step 3: Implement permissions and AuthorizationService.**

Declare permissions once, map roles centrally, and use cached membership lookups with a PostgreSQL fallback. Cache keys must include both user and organization IDs. A cache miss reads the database; a Redis error never grants access.

- [ ] **Step 4: Implement PermissionsGuard.**

Read the `RequirePermissions` metadata and `organizationId` route parameter, resolve the local user from the authenticated principal, and call `requirePermission` before controller execution. Attach the membership context for `CurrentOrganization` consumers.

- [ ] **Step 5: Implement tenant controllers.**

Implement organization get/update and member list/create/update-role/delete endpoints. Apply Zod schemas, `CognitoAuthGuard`, and `PermissionsGuard` with exact permissions. Accept membership `userId` only for an already synchronized local user; do not implement invitations or Cognito provisioning.

- [ ] **Step 6: Add cache invalidation to mutations.**

After a successful organization or membership mutation, delete affected organization, member-list, membership, and `/me` keys. If invalidation fails, keep the mutation result but log a redacted warning; the next read will fall back to PostgreSQL.

- [ ] **Step 7: Run authorization/tenant tests and typecheck.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/authorization src/modules/organizations src/modules/memberships
pnpm --dir apps/api typecheck
```

Expected result: PASS.

---

## Task 9: Configure Nest bootstrap, CORS/CSRF, logging, rate limits, Swagger, and health

**Files:**

- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/src/app.module.ts`
- Create: common request ID/origin guard files from the file map
- Create: health module/controller/indicators
- Tests: `main`/bootstrap contract tests and health controller tests

**Interfaces:**

- API prefix: `/api/v1`.
- Swagger URL: `/api/docs`.
- Health URL: `/api/v1/health`.
- CORS origin: exact `WEB_URL`, credentials enabled.

- [ ] **Step 1: Write health and HTTP bootstrap tests.**

Test public health behavior, unauthorized access to protected routes, rejection of disallowed origins on unsafe requests, CORS credentials configuration, and route prefix behavior. Mock Prisma and Redis health checks.

- [ ] **Step 2: Run tests and confirm failure.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/health test
```

Expected result: FAIL until the bootstrap and health modules are wired.

- [ ] **Step 3: Configure AppModule.**

Import global `ConfigModule`, PrismaModule, RedisModule, CognitoModule, AuthModule, UsersModule, OrganizationsModule, MembershipsModule, AuthorizationModule, and HealthModule. Remove fake Observe app key/secret configuration. Register `LoggerModule.forRoot` with Pino redaction for request headers, cookies, passwords, authorization, token-like fields, database URL, and Redis URL.

- [ ] **Step 4: Configure main.ts.**

Create the Nest application with the Pino logger, cookie parser, Helmet, `/api/v1` prefix, exact-origin CORS, graceful shutdown hooks, Swagger, and request ID interceptor. Do not enable a class-validator `ValidationPipe`; controllers use Zod pipes.

- [ ] **Step 5: Implement origin guard and throttling.**

Reject unsafe requests whose Origin/Referer is absent or outside `WEB_URL` in production. Allow the configured localhost development origin. Configure `@nestjs/throttler` with route-specific login/refresh limits and a higher general limit; do not use wildcard CORS.

- [ ] **Step 6: Implement health indicators.**

Use Terminus for application status, a lightweight Prisma query, and Redis `PING`. Return only status metadata; never return connection strings, provider errors, or credentials.

- [ ] **Step 7: Run API build, tests, and lint.**

Run:

```powershell
pnpm --dir apps/api exec vitest run src/modules/health test
pnpm --dir apps/api build
pnpm --dir apps/api lint
pnpm --dir apps/api typecheck
```

Expected result: PASS, with any pre-existing non-blocking warnings recorded.

---

## Task 10: Build the React HTTP and TanStack Query foundation

**Files:**

- Create: `apps/web/src/lib/api/api-error.ts`
- Create: `apps/web/src/lib/api/http-client.ts`
- Create: `apps/web/src/lib/query/query-client.ts`
- Create: `apps/web/src/lib/query/query-keys.ts`
- Create: `apps/web/src/app/providers/query-provider.tsx`
- Modify: `apps/web/src/app/providers/app-providers.tsx`
- Modify: `apps/web/vite.config.ts`

**Interfaces:**

```ts
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T>;
export const queryKeys = {
  me: ['me'] as const,
  organization: (id: string) => ['organization', id] as const,
  members: (id: string) => ['members', id] as const,
};
```

- [ ] **Step 1: Implement the shared API error type.**

Parse `{ statusCode, code, message, requestId? }` without exposing response bodies containing secrets. Unknown responses become a generic client error.

- [ ] **Step 2: Implement apiFetch with one refresh retry.**

Use relative `/api/v1` paths and `credentials: 'include'`. On a non-auth request receiving 401, call `POST /api/v1/auth/refresh` once, then retry the original request once. Never retry login/refresh recursively. Throw `ApiError` after the second failure.

- [ ] **Step 3: Configure QueryClient.**

Use a `QueryClient` with approximately 30-second stale time, bounded garbage collection, no infinite retry for 401, and a retry function that avoids retrying validation/auth failures. Add `QueryClientProvider` inside the existing `PxlKitSurfaceProvider` composition.

- [ ] **Step 4: Add the Vite development proxy.**

Configure `server.proxy['/api']` to `http://localhost:3000`, preserving the frontend contract `fetch('/api/v1/...')`. Do not hardcode Cognito or database settings in the web bundle.

- [ ] **Step 5: Build the web app.**

Run:

```powershell
pnpm --dir apps/web lint
pnpm --dir apps/web build
```

Expected result: PASS before feature hooks are added.

---

## Task 11: Implement React auth API, login page, session query, and protected routing

**Files:**

- Create auth API/types/schema/hooks/components/pages from the file map
- Create: `apps/web/src/app/router/protected-route.tsx`
- Modify: `apps/web/src/app/router/router.tsx`

**Interfaces:**

```ts
export type MeResponse = {
  user: { id: string; email: string; displayName: string | null };
  organizations: Array<{ id: string; name: string; slug: string; role: Role }>;
};

export function useMe(): UseQueryResult<MeResponse, ApiError>;
export function useLogin(): UseMutationResult<SafeUser, ApiError, LoginInput>;
export function useLogout(): UseMutationResult<void, ApiError, void>;
```

- [ ] **Step 1: Write pure login validation.**

Implement email syntax and non-empty password validation in `auth.schema.ts`. Add no Cognito dependency and no hard-coded credentials.

- [ ] **Step 2: Implement auth API functions and hooks.**

`login` posts email/password with JSON and credentials, `me` calls `/api/v1/me`, and `logout` posts with credentials. The hooks use TanStack Query and invalidate/remove `['me']` on login/logout.

- [ ] **Step 3: Implement the custom OpsGrid login page.**

Create the approved split auth layout, brand panel, form validation, loading state, inline errors, and safe API error message. Keep the existing theme toggle and do not add Google/Cognito SDK behavior outside the approved backend flow. The login form must never read or display cookies/tokens.

- [ ] **Step 4: Implement protected routing.**

Create a protected route component that uses `useMe`. Render a loading state while the query is pending, redirect 401/auth failures to `/login`, and render the outlet only for an authenticated user. Keep `/login` public and preserve `/` → `/dashboard`.

- [ ] **Step 5: Run web checks.**

Run:

```powershell
pnpm --dir apps/web lint
pnpm --dir apps/web build
```

Expected result: PASS. Check that `/login` does not render the dashboard shell and `/` still resolves through `/dashboard`.

---

## Task 12: Replace mock tenant state with API-backed organizations and members

**Files:**

- Create: organization and membership API/hooks from the file map
- Modify: `apps/web/src/app/providers/app-providers.tsx`
- Modify: `apps/web/src/components/shell/tenant-switcher.tsx`
- Modify: `apps/web/src/components/shell/user-menu.tsx`
- Modify: `apps/web/src/features/dashboard/pages/dashboard-page.tsx`
- Modify: `apps/web/src/types/domain.ts`
- Remove only unused mock imports/files after verifying no references remain

**Interfaces:**

```ts
export function useOrganizations(): Organization[];
export function useOrganizationMembers(organizationId: string | null): UseQueryResult<Member[], ApiError>;
```

- [ ] **Step 1: Implement organization/member API modules.**

Use `apiFetch` and the exact query keys. Organization detail and member list responses must map to UI-safe domain types. Membership mutations invalidate `['me']` and the affected organization/member keys.

- [ ] **Step 2: Refactor TenantProvider.**

Keep only `selectedOrganizationId` as client state. Derive organizations from `useMe` data. Select the first server organization when the current selection is missing; set current organization to `null` when the server list is empty.

- [ ] **Step 3: Refactor shell components.**

Update `TenantSwitcher` and `UserMenu` to use API-backed user/organization data. Add disabled/loading/empty states. Keep accessible labels and existing PxlKit components.

- [ ] **Step 4: Refactor dashboard data.**

Replace mock organization and member reads with query hooks. Render a no-organization state when `currentOrganization` is null. Render member loading/error states and use only fields supplied by the API; remove fabricated plan/environment data.

- [ ] **Step 5: Remove unused mock runtime imports.**

Search all web source for `mocks/current-user`, `mocks/organizations`, and `mocks/members`. Delete only files with no remaining references. Keep UI-only getting-started data if still used.

- [ ] **Step 6: Run web lint/build.**

Run:

```powershell
pnpm --dir apps/web lint
pnpm --dir apps/web build
```

Expected result: PASS with no unused mock imports and no horizontal overflow introduced by the no-organization state.

---

## Task 13: Add API integration/e2e contract coverage with external services mocked

**Files:**

- Modify: `apps/api/test/app.e2e-spec.ts`
- Create focused e2e/spec fixtures only where needed
- Modify: test module setup to override Cognito, Prisma, Redis, and config providers

**Interfaces:**

- HTTP tests cover `/api/v1/auth/login`, `/api/v1/auth/refresh`, `/api/v1/auth/logout`, `/api/v1/me`, health, organization, and member routes.

- [ ] **Step 1: Replace starter root assertion.**

Remove the `Hello World!` expectation and assert the configured API prefix/health endpoint. Do not keep a public root route that exposes starter text.

- [ ] **Step 2: Add mocked login/me contract tests.**

Override `CognitoService` with deterministic authentication results, `CognitoTokenVerifierService` with verified claims, `PrismaService` with user/membership data, and `CacheService` with an in-memory test double. Assert Set-Cookie attributes and safe JSON response absence of tokens/passwords.

- [ ] **Step 3: Add refresh/logout/authorization tests.**

Send cookies through Supertest, assert refresh replacement and logout clearing, assert a user with no membership receives an empty organization list, assert cross-organization access is forbidden, and assert role permission differences.

- [ ] **Step 4: Run e2e and full backend tests.**

Run:

```powershell
pnpm --dir apps/api test
pnpm --dir apps/api test:e2e
```

Expected result: PASS without AWS, Neon, or hosted Redis network calls.

---

## Task 14: Validate database, Redis, Cognito Terraform, and real local startup

**Files:**

- Modify only when a command identifies a concrete defect.
- Do not change Terraform architecture without a provider/configuration reason.

- [ ] **Step 1: Run formatting and static validation.**

Run:

```powershell
pnpm --dir apps/api format:check
pnpm --dir apps/api lint
pnpm --dir apps/api typecheck
pnpm --dir apps/api build
pnpm --dir apps/web lint
pnpm --dir apps/web build
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/environments/dev/persistent/identity validate
```

Record exact outputs. Fix only concrete defects and rerun the failed command.

- [ ] **Step 2: Run Prisma migration validation.**

Run:

```powershell
pnpm --dir apps/api prisma:generate
pnpm --dir apps/api prisma:migrate:deploy
```

If Neon is reachable and credentials are valid, record successful migration output. If not, record the exact failure and do not claim database connectivity.

- [ ] **Step 3: Start the API and web dev servers using managed background jobs.**

Use the existing API and web commands, not replacement servers:

```powershell
pnpm --dir apps/api start:dev
pnpm --dir apps/web dev -- --host 127.0.0.1 --port 5173
```

Track every background job ID. Verify the exact API and frontend URLs. Stop jobs that no longer matter before the final report.

- [ ] **Step 4: Verify health and browser flow.**

Check `/api/v1/health`, open `/login`, submit a real Cognito login only if a valid test user/password is available, verify `/me`, refresh behavior, logout, no-organization behavior, organization switching, and member loading. Never paste credentials or tokens into the report.

- [ ] **Step 5: Inspect Terraform requirements.**

Confirm the existing root/module still reports:

```text
generate_secret = true
ALLOW_USER_PASSWORD_AUTH
ALLOW_REFRESH_TOKEN_AUTH
region = ap-southeast-1
```

Do not run or claim `terraform apply` unless explicitly required and the real command succeeds.

---

## Task 15: Final uncommitted review package

**Files:**

- All implementation files created or modified by Tasks 1–14.
- No staging area changes are allowed.

- [ ] **Step 1: Run the complete verification set.**

Run:

```powershell
pnpm --dir apps/api lint
pnpm --dir apps/api typecheck
pnpm --dir apps/api build
pnpm --dir apps/api test
pnpm --dir apps/api test:e2e
pnpm --dir apps/web lint
pnpm --dir apps/web build
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/environments/dev/persistent/identity validate
git diff --check
```

- [ ] **Step 2: Run security and scope scans.**

Search tracked and untracked source changes for password/token/secret logging, localStorage/sessionStorage token persistence, Cognito direct browser calls, `origin: '*'`, Cognito Groups, static AWS keys, `jsonwebtoken`, `passport`, `bcrypt`, `argon2`, and Phase 2 feature names. Verify no real secret value appears in the diff.

- [ ] **Step 3: Review status without staging.**

Run:

```powershell
git status --short --untracked-files=all
git diff --stat
git diff --name-only
git diff --check
```

Do not run `git add`, `git commit`, merge, cherry-pick, or any staging command. Present the uncommitted diff, verification results, changed-file summary, Terraform result, and any external-service limitations to the user.

- [ ] **Step 4: Wait for explicit user review authorization.**

Stop after presenting the review package. Only after the user explicitly authorizes staging/commit/merge may a separate follow-up process perform those Git operations. Until then, the working tree remains uncommitted.

## Final report contents

The implementation handoff must report:

1. Final API and React folder architecture.
2. Packages added/removed and exact package scripts.
3. Prisma schema, migration, seed behavior, and migration result.
4. Login, refresh, logout, `/me`, and tenant authorization flow.
5. Cognito `USER_PASSWORD_AUTH`, conditional `SECRET_HASH`, access-token verification, and refresh username-cookie handling.
6. Redis cache keys, TTLs, invalidation, and fallback behavior.
7. Cookie, CORS, CSRF/origin, throttling, logging, Swagger, and health behavior.
8. TanStack Query integration and protected React routes.
9. Exact lint, typecheck, build, unit, e2e, Terraform, and browser verification results.
10. Which real AWS/Cognito, Neon, or Redis checks could not run and why.
11. An explicit statement that all changes are uncommitted pending user review.
