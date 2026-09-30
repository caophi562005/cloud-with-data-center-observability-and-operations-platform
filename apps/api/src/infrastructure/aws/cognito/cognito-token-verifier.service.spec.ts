import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CognitoTokenVerifierService } from './cognito-token-verifier.service.js';

describe('CognitoTokenVerifierService', () => {
  it('verifies access tokens with the access-token verifier', async () => {
    const accessVerifier = {
      verify: vi.fn().mockResolvedValue({
        sub: 'user-sub',
        client_id: 'client-id',
        token_use: 'access',
        scope: 'openid',
      }),
    };
    const idVerifier = { verify: vi.fn() };
    const service = new CognitoTokenVerifierService(accessVerifier, idVerifier);

    await expect(service.verifyAccessToken('access-token')).resolves.toEqual({
      sub: 'user-sub',
      client_id: 'client-id',
      token_use: 'access',
      scope: 'openid',
    });
    expect(accessVerifier.verify).toHaveBeenCalledWith('access-token');
    expect(idVerifier.verify).not.toHaveBeenCalled();
  });

  it('verifies ID tokens with the ID-token verifier', async () => {
    const accessVerifier = { verify: vi.fn() };
    const idVerifier = {
      verify: vi.fn().mockResolvedValue({
        sub: 'user-sub',
        aud: 'client-id',
        token_use: 'id',
        email: 'admin@example.com',
      }),
    };
    const service = new CognitoTokenVerifierService(accessVerifier, idVerifier);

    await expect(service.verifyIdToken('id-token')).resolves.toEqual({
      sub: 'user-sub',
      aud: 'client-id',
      token_use: 'id',
      email: 'admin@example.com',
    });
    expect(idVerifier.verify).toHaveBeenCalledWith('id-token');
    expect(accessVerifier.verify).not.toHaveBeenCalled();
  });

  it('maps verifier failures to a safe unauthorized error', async () => {
    const verifierError = new Error('JWKS response contained a secret token');
    const accessVerifier = { verify: vi.fn().mockRejectedValue(verifierError) };
    const idVerifier = { verify: vi.fn() };
    const service = new CognitoTokenVerifierService(accessVerifier, idVerifier);

    const error = await service
      .verifyAccessToken('invalid-token')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      statusCode: 401,
      message: 'Unable to verify Cognito token',
      error: 'Unauthorized',
    });
    expect((error as Error).message).not.toContain('JWKS');
  });
});
