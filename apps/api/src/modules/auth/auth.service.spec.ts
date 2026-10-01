import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CognitoAccessTokenClaims,
  CognitoAuthenticationResult,
  CognitoIdTokenClaims,
} from '../../infrastructure/aws/cognito/cognito.types.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import { CognitoTokenVerifierService } from '../../infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CognitoService } from '../../infrastructure/aws/cognito/cognito.service.js';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthCookieService } from './auth-cookie.service.js';
import { AuthService } from './auth.service.js';

type ServiceMocks = {
  cognito: {
    signInWithPassword: ReturnType<typeof vi.fn>;
    refreshToken: ReturnType<typeof vi.fn>;
    revokeToken: ReturnType<typeof vi.fn>;
    signUp: ReturnType<typeof vi.fn>;
    confirmSignUp: ReturnType<typeof vi.fn>;
    resendConfirmationCode: ReturnType<typeof vi.fn>;
  };
  verifier: {
    verifyAccessToken: ReturnType<typeof vi.fn>;
    verifyIdToken: ReturnType<typeof vi.fn>;
  };
  users: {
    upsertFromCognito: ReturnType<typeof vi.fn>;
    findByCognitoSub: ReturnType<typeof vi.fn>;
  };
  organizations: {
    findForUser: ReturnType<typeof vi.fn>;
    provisionPersonalOrganization: ReturnType<typeof vi.fn>;
  };
  cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  cookies: {
    setAccessToken: ReturnType<typeof vi.fn>;
    setRefreshToken: ReturnType<typeof vi.fn>;
    setCognitoUsername: ReturnType<typeof vi.fn>;
    clearAuthCookies: ReturnType<typeof vi.fn>;
  };
};

const response = {} as Response;
const accessClaims: CognitoAccessTokenClaims = {
  sub: 'cognito-sub-1',
  client_id: 'client-id',
  token_use: 'access',
  scope: 'openid',
};
const idClaims: CognitoIdTokenClaims = {
  sub: 'cognito-sub-1',
  aud: 'client-id',
  token_use: 'id',
  email: 'person@example.com',
  name: 'Person',
};
const localUser = {
  id: 'user-1',
  cognitoSub: 'cognito-sub-1',
  email: 'person@example.com',
  displayName: 'Person',
};

function createMocks(): ServiceMocks {
  return {
    cognito: {
      signInWithPassword: vi.fn(),
      refreshToken: vi.fn(),
      revokeToken: vi.fn(),
      signUp: vi.fn(),
      confirmSignUp: vi.fn(),
      resendConfirmationCode: vi.fn(),
    },
    verifier: {
      verifyAccessToken: vi.fn(),
      verifyIdToken: vi.fn(),
    },
    users: {
      upsertFromCognito: vi.fn(),
      findByCognitoSub: vi.fn(),
    },
    organizations: {
      findForUser: vi.fn(),
      provisionPersonalOrganization: vi.fn(),
    },
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    cookies: {
      setAccessToken: vi.fn(),
      setRefreshToken: vi.fn(),
      setCognitoUsername: vi.fn(),
      clearAuthCookies: vi.fn(),
    },
  };
}

function createService(
  mocks: ServiceMocks,
  options: { clientSecret?: string } = { clientSecret: 'client-secret' },
): AuthService {
  return new AuthService(
    mocks.cognito as unknown as CognitoService,
    mocks.verifier as unknown as CognitoTokenVerifierService,
    mocks.users as unknown as UsersService,
    mocks.organizations as unknown as OrganizationsService,
    mocks.cache as unknown as CacheService,
    mocks.cookies as unknown as AuthCookieService,
    {
      region: 'ap-southeast-1',
      userPoolId: 'ap-southeast-1_example',
      clientId: 'client-id',
      clientSecret: options.clientSecret,
    },
  );
}

function requestWithCookies(cookies: Record<string, string>): Request {
  return { cookies } as unknown as Request;
}

describe('AuthService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns confirmation-required registration data without setting auth cookies', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.signUp.mockResolvedValue({
      userConfirmed: false,
      codeDeliveryDetails: {
        destination: 'p***@example.com',
      },
    });

    await expect(
      service.register({
        email: 'person@example.com',
        displayName: 'Person',
        password: 'Correct-Horse-123',
      }),
    ).resolves.toEqual({
      status: 'CONFIRMATION_REQUIRED',
      email: 'person@example.com',
      destination: 'p***@example.com',
    });
    expect(mocks.cognito.signUp).toHaveBeenCalledWith(
      'person@example.com',
      'Correct-Horse-123',
      'Person',
    );
    expect(mocks.cookies.clearAuthCookies).not.toHaveBeenCalled();
    expect(
      JSON.stringify(
        await service.register({
          email: 'person@example.com',
          displayName: 'Person',
          password: 'Correct-Horse-123',
        }),
      ),
    ).not.toContain('Correct-Horse-123');
  });

  it('confirms registration and resends confirmation codes without creating a session', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.confirmSignUp.mockResolvedValue(undefined);
    mocks.cognito.resendConfirmationCode.mockResolvedValue({
      destination: 'p***@example.com',
    });

    await expect(
      service.confirmRegistration({
        email: 'person@example.com',
        confirmationCode: '123456',
      }),
    ).resolves.toEqual({ status: 'CONFIRMED' });
    await expect(
      service.resendRegistrationCode({ email: 'person@example.com' }),
    ).resolves.toEqual({
      status: 'CONFIRMATION_REQUIRED',
      email: 'person@example.com',
      destination: 'p***@example.com',
    });
    expect(mocks.cognito.confirmSignUp).toHaveBeenCalledWith(
      'person@example.com',
      '123456',
    );
    expect(mocks.cognito.resendConfirmationCode).toHaveBeenCalledWith(
      'person@example.com',
    );
    expect(mocks.cookies.setAccessToken).not.toHaveBeenCalled();
  });

  it('verifies access and ID tokens, synchronizes by Cognito sub, sets cookies, and returns safe login data', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const authentication: CognitoAuthenticationResult = {
      accessToken: 'access-token',
      idToken: 'id-token',
      refreshToken: 'refresh-token',
    };
    mocks.cognito.signInWithPassword.mockResolvedValue(authentication);
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.verifier.verifyIdToken.mockResolvedValue(idClaims);
    mocks.users.upsertFromCognito.mockResolvedValue(localUser);

    await expect(
      service.login(
        { email: 'person@example.com', password: 'password' },
        response,
      ),
    ).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
    });

    expect(mocks.verifier.verifyAccessToken).toHaveBeenCalledWith(
      'access-token',
    );
    expect(mocks.verifier.verifyIdToken).toHaveBeenCalledWith('id-token');
    expect(mocks.users.upsertFromCognito).toHaveBeenCalledWith({
      cognitoSub: 'cognito-sub-1',
      email: 'person@example.com',
      displayName: 'Person',
    });
    expect(mocks.cookies.setAccessToken).toHaveBeenCalledWith(
      response,
      'access-token',
    );
    expect(mocks.cookies.setRefreshToken).toHaveBeenCalledWith(
      response,
      'refresh-token',
    );
    expect(mocks.cookies.setCognitoUsername).toHaveBeenCalledWith(
      response,
      'person@example.com',
    );

    const serialized = JSON.stringify(
      await service.login(
        { email: 'person@example.com', password: 'password' },
        response,
      ),
    );
    expect(serialized).not.toContain('access-token');
    expect(serialized).not.toContain('refresh-token');
    expect(serialized).not.toContain('password');
  });

  it('provisions a personal organization with the synchronized user and verified email after login', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const authentication: CognitoAuthenticationResult = {
      accessToken: 'access-token',
      idToken: 'id-token',
      refreshToken: 'refresh-token',
    };
    const verifiedEmail = 'phic0206@ut.edu.vn';
    mocks.cognito.signInWithPassword.mockResolvedValue(authentication);
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.verifier.verifyIdToken.mockResolvedValue({
      ...idClaims,
      email: verifiedEmail,
    });
    mocks.users.upsertFromCognito.mockResolvedValue({
      ...localUser,
      email: verifiedEmail,
    });
    mocks.organizations.provisionPersonalOrganization.mockResolvedValue(
      undefined,
    );

    await service.login(
      { email: 'unverified-input@example.com', password: 'password' },
      response,
    );

    expect(mocks.users.upsertFromCognito).toHaveBeenCalledWith({
      cognitoSub: 'cognito-sub-1',
      email: verifiedEmail,
      displayName: 'Person',
    });
    expect(mocks.organizations.provisionPersonalOrganization).toHaveBeenCalledWith(
      'user-1',
      verifiedEmail,
    );
  });

  it('does not set the internal username cookie for a public client', async () => {
    const mocks = createMocks();
    const service = createService(mocks, { clientSecret: undefined });
    mocks.cognito.signInWithPassword.mockResolvedValue({
      accessToken: 'access-token',
      idToken: 'id-token',
      refreshToken: 'refresh-token',
    });
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.verifier.verifyIdToken.mockResolvedValue(idClaims);
    mocks.users.upsertFromCognito.mockResolvedValue(localUser);

    await expect(
      service.login(
        { email: 'person@example.com', password: 'password' },
        response,
      ),
    ).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
    });
    expect(mocks.cookies.setCognitoUsername).not.toHaveBeenCalled();
  });

  it('rejects a login when verified access and ID subjects do not match', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.signInWithPassword.mockResolvedValue({
      accessToken: 'access-token',
      idToken: 'id-token',
      refreshToken: 'refresh-token',
    });
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.verifier.verifyIdToken.mockResolvedValue({
      ...idClaims,
      sub: 'different-sub',
    });

    await expect(
      service.login(
        { email: 'person@example.com', password: 'password' },
        response,
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    expect(mocks.users.upsertFromCognito).not.toHaveBeenCalled();
    expect(mocks.cookies.setAccessToken).not.toHaveBeenCalled();
  });

  it('propagates Cognito invalid-credentials errors without synchronizing a user', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const error = new UnauthorizedException({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid credentials',
    });
    mocks.cognito.signInWithPassword.mockRejectedValue(error);

    await expect(
      service.login({ email: 'person@example.com', password: 'bad' }, response),
    ).rejects.toBe(error);
    expect(mocks.users.upsertFromCognito).not.toHaveBeenCalled();
    expect(mocks.cookies.setAccessToken).not.toHaveBeenCalled();
  });

  it('rejects login without a refresh token and clears any stale auth cookies', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.signInWithPassword.mockResolvedValue({
      accessToken: 'access-token',
      idToken: 'id-token',
    });

    await expect(
      service.login(
        { email: 'person@example.com', password: 'password' },
        response,
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    expect(mocks.cookies.clearAuthCookies).toHaveBeenCalledWith(response);
    expect(mocks.verifier.verifyAccessToken).not.toHaveBeenCalled();
    expect(mocks.users.upsertFromCognito).not.toHaveBeenCalled();
  });

  it('returns an empty organization list for a synchronized user without memberships', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const principal: AuthenticatedUser = {
      cognitoSub: 'cognito-sub-1',
      clientId: 'client-id',
      tokenUse: 'access',
    };
    mocks.users.findByCognitoSub.mockResolvedValue(localUser);
    mocks.cache.get.mockResolvedValue(null);
    mocks.organizations.findForUser.mockResolvedValue([]);

    await expect(service.getCurrentSession(principal)).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
      organizations: [],
    });
    expect(mocks.users.findByCognitoSub).toHaveBeenCalledWith('cognito-sub-1');
    expect(mocks.organizations.findForUser).toHaveBeenCalledWith('user-1');
    expect(mocks.cache.set).toHaveBeenCalledWith(
      'cloudops:v1:me:user-1',
      {
        user: {
          id: 'user-1',
          email: 'person@example.com',
          displayName: 'Person',
        },
        organizations: [],
      },
      30,
    );
  });

  it('resolves the local user before using safe /me cache metadata', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const principal: AuthenticatedUser = {
      cognitoSub: 'cognito-sub-1',
      clientId: 'client-id',
      tokenUse: 'access',
    };
    const cachedResponse = {
      user: {
        id: 'user-1',
        email: 'cached@example.com',
        displayName: 'Cached Person',
      },
      organizations: [],
    };
    mocks.users.findByCognitoSub.mockResolvedValue(localUser);
    mocks.cache.get.mockResolvedValue(cachedResponse);

    await expect(service.getCurrentSession(principal)).resolves.toEqual(
      cachedResponse,
    );
    expect(mocks.users.findByCognitoSub).toHaveBeenCalledWith('cognito-sub-1');
    expect(mocks.organizations.findForUser).not.toHaveBeenCalled();
  });

  it('normalizes safe cached metadata and strips poisoned extra fields', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const principal: AuthenticatedUser = {
      cognitoSub: 'cognito-sub-1',
      clientId: 'client-id',
      tokenUse: 'access',
    };
    mocks.users.findByCognitoSub.mockResolvedValue(localUser);
    mocks.cache.get.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'cached@example.com',
        displayName: 'Cached Person',
        accessToken: 'poisoned-access-token',
        password: 'poisoned-password',
      },
      organizations: [
        {
          id: 'org-1',
          name: 'CloudOps',
          slug: 'cloudops',
          role: 'ADMIN',
          refreshToken: 'poisoned-refresh-token',
        },
      ],
      secret: 'poisoned-secret',
    });

    await expect(service.getCurrentSession(principal)).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'cached@example.com',
        displayName: 'Cached Person',
      },
      organizations: [
        {
          id: 'org-1',
          name: 'CloudOps',
          slug: 'cloudops',
          role: 'ADMIN',
        },
      ],
    });
    expect(mocks.organizations.findForUser).not.toHaveBeenCalled();
    const serialized = JSON.stringify(
      await service.getCurrentSession(principal),
    );
    expect(serialized).not.toContain('poisoned');
  });

  it('falls back to the database when cached organization metadata is invalid', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    const principal: AuthenticatedUser = {
      cognitoSub: 'cognito-sub-1',
      clientId: 'client-id',
      tokenUse: 'access',
    };
    const organizations = [
      { id: 'org-1', name: 'CloudOps', slug: 'cloudops', role: 'VIEWER' },
    ];
    mocks.users.findByCognitoSub.mockResolvedValue(localUser);
    mocks.cache.get.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'cached@example.com',
        displayName: 'Cached Person',
      },
      organizations: [
        {
          id: 'org-1',
          name: 'CloudOps',
          slug: 'cloudops',
          role: 'NOT_A_ROLE',
        },
      ],
    });
    mocks.organizations.findForUser.mockResolvedValue(organizations);

    await expect(service.getCurrentSession(principal)).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
      organizations,
    });
    expect(mocks.organizations.findForUser).toHaveBeenCalledWith('user-1');
  });

  it('refreshes with the username cookie and rotates an optional refresh token', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.refreshToken.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.users.findByCognitoSub.mockResolvedValue(localUser);

    await expect(
      service.refresh(
        requestWithCookies({
          refresh_token: 'refresh-token',
          cognito_username: 'person@example.com',
        }),
        response,
      ),
    ).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
    });

    expect(mocks.cognito.refreshToken).toHaveBeenCalledWith(
      'refresh-token',
      'person@example.com',
    );
    expect(mocks.verifier.verifyAccessToken).toHaveBeenCalledWith(
      'new-access-token',
    );
    expect(mocks.cookies.setAccessToken).toHaveBeenCalledWith(
      response,
      'new-access-token',
    );
    expect(mocks.cookies.setRefreshToken).toHaveBeenCalledWith(
      response,
      'new-refresh-token',
    );
  });

  it('clears cookies when the refresh token cookie is absent', async () => {
    const mocks = createMocks();
    const service = createService(mocks);

    await expect(
      service.refresh(requestWithCookies({}), response),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    expect(mocks.cognito.refreshToken).not.toHaveBeenCalled();
    expect(mocks.cookies.clearAuthCookies).toHaveBeenCalledWith(response);
  });

  it('allows public-client refresh without a username cookie', async () => {
    const mocks = createMocks();
    const service = createService(mocks, { clientSecret: undefined });
    mocks.cognito.refreshToken.mockResolvedValue({ accessToken: 'access' });
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.users.findByCognitoSub.mockResolvedValue(localUser);

    await expect(
      service.refresh(
        requestWithCookies({ refresh_token: 'refresh' }),
        response,
      ),
    ).resolves.toEqual({
      user: {
        id: 'user-1',
        email: 'person@example.com',
        displayName: 'Person',
      },
    });
    expect(mocks.cognito.refreshToken).toHaveBeenCalledWith('refresh');
  });

  it('clears cookies when the refreshed access token cannot be verified', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.refreshToken.mockResolvedValue({
      accessToken: 'new-access-token',
    });
    mocks.verifier.verifyAccessToken.mockRejectedValue(
      new UnauthorizedException('invalid token'),
    );

    await expect(
      service.refresh(
        requestWithCookies({
          refresh_token: 'refresh-token',
          cognito_username: 'person@example.com',
        }),
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(mocks.cookies.clearAuthCookies).toHaveBeenCalledWith(response);
    expect(mocks.cookies.setAccessToken).not.toHaveBeenCalled();
  });

  it('clears cookies when the refreshed access token has no local user', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.refreshToken.mockResolvedValue({
      accessToken: 'new-access-token',
    });
    mocks.verifier.verifyAccessToken.mockResolvedValue(accessClaims);
    mocks.users.findByCognitoSub.mockResolvedValue(null);

    await expect(
      service.refresh(
        requestWithCookies({
          refresh_token: 'refresh-token',
          cognito_username: 'person@example.com',
        }),
        response,
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    expect(mocks.cookies.clearAuthCookies).toHaveBeenCalledWith(response);
    expect(mocks.cookies.setAccessToken).not.toHaveBeenCalled();
  });

  it('clears cookies and rejects confidential refresh without the username cookie', async () => {
    const mocks = createMocks();
    const service = createService(mocks);

    await expect(
      service.refresh(
        requestWithCookies({ refresh_token: 'refresh' }),
        response,
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_UNAUTHORIZED',
        message: 'Authentication required',
      },
    });
    expect(mocks.cognito.refreshToken).not.toHaveBeenCalled();
    expect(mocks.cookies.clearAuthCookies).toHaveBeenCalledWith(response);
  });

  it('always clears cookies when logout revocation fails', async () => {
    const mocks = createMocks();
    const service = createService(mocks);
    mocks.cognito.revokeToken.mockRejectedValue(
      new Error('provider request token=secret'),
    );

    await expect(
      service.logout(
        requestWithCookies({ refresh_token: 'refresh-token' }),
        response,
      ),
    ).resolves.toBeUndefined();
    expect(mocks.cognito.revokeToken).toHaveBeenCalledWith('refresh-token');
    expect(mocks.cookies.clearAuthCookies).toHaveBeenCalledWith(response);
  });
});
