import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../../../common/types/request-context.type.js';
import type { CognitoAccessTokenClaims } from '../../../infrastructure/aws/cognito/cognito.types.js';
import { CognitoTokenVerifierService } from '../../../infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CognitoAuthGuard } from './cognito-auth.guard.js';

function createContext(request: RequestContext): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CognitoAuthGuard', () => {
  const verifier = {
    verifyAccessToken: vi.fn(),
    verifyIdToken: vi.fn(),
  };
  let guard: CognitoAuthGuard;

  beforeEach(() => {
    vi.clearAllMocks();
    guard = new CognitoAuthGuard(
      verifier as unknown as CognitoTokenVerifierService,
    );
  });

  it('verifies only the access cookie and attaches an AuthenticatedUser principal', async () => {
    const claims: CognitoAccessTokenClaims = {
      sub: 'cognito-sub-1',
      client_id: 'client-id',
      token_use: 'access',
      scope: 'openid profile',
      role: 'ADMIN',
    };
    verifier.verifyAccessToken.mockResolvedValue(claims);
    const request = {
      cookies: {
        access_token: 'access-token',
        id_token: 'browser-supplied-id-token',
      },
    } as unknown as RequestContext;

    await expect(guard.canActivate(createContext(request))).resolves.toBe(true);
    expect(verifier.verifyAccessToken).toHaveBeenCalledWith('access-token');
    expect(verifier.verifyIdToken).not.toHaveBeenCalled();
    expect(request.user).toEqual({
      cognitoSub: 'cognito-sub-1',
      clientId: 'client-id',
      scope: 'openid profile',
      tokenUse: 'access',
    });
    expect(request.user).not.toHaveProperty('role');
  });

  it('rejects a missing access cookie with a safe unauthorized error', async () => {
    const request = { cookies: {} } as unknown as RequestContext;

    const error = await guard
      .canActivate(createContext(request))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: 'AUTH_UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('maps token verification failures to a safe unauthorized error', async () => {
    verifier.verifyAccessToken.mockRejectedValue(
      new Error('JWKS request id=secret token=access-token'),
    );
    const request = {
      cookies: { access_token: 'access-token' },
    } as unknown as RequestContext;

    const error = await guard
      .canActivate(createContext(request))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: 'AUTH_UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect((error as Error).message).not.toContain('secret');
    expect(request.user).toBeUndefined();
  });
});
