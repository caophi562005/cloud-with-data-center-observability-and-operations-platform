import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { authConfig } from '../src/config/auth.config.js';
import { CognitoService } from '../src/infrastructure/aws/cognito/cognito.service.js';
import { CognitoTokenVerifierService } from '../src/infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CacheService } from '../src/infrastructure/cache/cache.service.js';
import { RedisService } from '../src/infrastructure/cache/redis.service.js';
import { PrismaService } from '../src/infrastructure/database/prisma/prisma.service.js';
import { CognitoAuthGuard } from '../src/modules/auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../src/modules/authorization/guards/permissions.guard.js';

describe('AppModule dependency graph', () => {
  it('compiles the full application module with test configuration', async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3000';
    process.env.WEB_URL = 'http://localhost:5173';
    process.env.DATABASE_URL = 'postgresql://user:password@localhost/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.COGNITO_REGION = 'ap-southeast-1';
    process.env.COGNITO_USER_POOL_ID = 'ap-southeast-1_test';
    process.env.COGNITO_CLIENT_ID = 'test-client';

    process.env.COGNITO_CLIENT_SECRET = 'test-secret';

    const { AppModule } = await import('../src/app.module.js');
    const moduleBuilder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CognitoService)
      .useValue({
        signInWithPassword: vi.fn(),
        refreshToken: vi.fn(),
        revokeToken: vi.fn(),
      })
      .overrideProvider(CognitoTokenVerifierService)
      .useValue({
        verifyAccessToken: vi.fn(),
        verifyIdToken: vi.fn(),
      })
      .overrideGuard(CognitoAuthGuard)
      .useValue({ canActivate: vi.fn().mockResolvedValue(true) })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: vi.fn().mockResolvedValue(true) })
      .overrideProvider(PrismaService)
      .useValue({
        $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
      })
      .overrideProvider(RedisService)
      .useValue({ ping: vi.fn().mockResolvedValue(true) })
      .overrideProvider(CacheService)
      .useValue({
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        deleteByPrefix: vi.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(authConfig.KEY)
      .useValue({
        region: 'ap-southeast-1',
        userPoolId: 'ap-southeast-1_test',
        clientId: 'test-client',
        clientSecret: 'test-secret',
      });

    await expect(moduleBuilder.compile()).resolves.toBeDefined();
  }, 30_000);
});
