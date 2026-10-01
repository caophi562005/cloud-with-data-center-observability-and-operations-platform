import {
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { authConfig, type AuthConfig } from '../../config/auth.config.js';
import { AUTH_COOKIE_NAMES } from '../../common/constants/auth.constants.js';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type.js';
import type { CognitoRegistrationResult } from '../../infrastructure/aws/cognito/cognito.types.js';
import { CognitoTokenVerifierService } from '../../infrastructure/aws/cognito/cognito-token-verifier.service.js';
import { CognitoService } from '../../infrastructure/aws/cognito/cognito.service.js';
import { CacheService } from '../../infrastructure/cache/cache.service.js';
import type { OrganizationWithRole } from '../organizations/organizations.repository.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import type { LocalUser } from '../users/users.repository.js';
import { UsersService } from '../users/users.service.js';
import { AuthCookieService } from './auth-cookie.service.js';
import type { LoginInput } from './schemas/login.schema.js';
import type {
  ConfirmRegistrationInput,
  RegisterInput,
  ResendConfirmationInput,
} from './schemas/registration.schema.js';

const ME_CACHE_TTL_SECONDS = 30;
const ME_CACHE_PREFIX = 'cloudops:v1:me:';

const AUTH_UNAUTHORIZED_RESPONSE = {
  code: 'AUTH_UNAUTHORIZED',
  message: 'Authentication required',
} as const;

export type SafeUser = Pick<LocalUser, 'id' | 'email' | 'displayName'>;

export type SafeSessionResponse = {
  user: SafeUser;
};

export type RegistrationResponse = {
  status: 'CONFIRMATION_REQUIRED' | 'CONFIRMED';
  email?: string;
  destination?: string;
};

type RegistrationInput = Pick<
  RegisterInput,
  'email' | 'displayName' | 'password'
>;

export type MeResponse = SafeSessionResponse & {
  organizations: OrganizationWithRole[];
};

@Injectable()
export class AuthService {
  constructor(
    private readonly cognitoService: CognitoService,
    private readonly tokenVerifier: CognitoTokenVerifierService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly cacheService: CacheService,
    private readonly authCookieService: AuthCookieService,
    @Optional()
    @Inject(authConfig.KEY)
    private readonly configuration?: AuthConfig,
  ) {}

  async register(input: RegistrationInput): Promise<RegistrationResponse> {
    const registration = await this.cognitoService.signUp(
      input.email,
      input.password,
      input.displayName,
    );

    return registrationResponse(input.email, registration);
  }

  async confirmRegistration(
    input: ConfirmRegistrationInput,
  ): Promise<RegistrationResponse> {
    await this.cognitoService.confirmSignUp(
      input.email,
      input.confirmationCode,
    );
    return { status: 'CONFIRMED' };
  }

  async resendRegistrationCode(
    input: ResendConfirmationInput,
  ): Promise<RegistrationResponse> {
    const delivery = await this.cognitoService.resendConfirmationCode(
      input.email,
    );

    return {
      status: 'CONFIRMATION_REQUIRED',
      email: input.email,
      ...(delivery?.destination ? { destination: delivery.destination } : {}),
    };
  }

  async login(
    input: LoginInput,
    response: Response,
  ): Promise<SafeSessionResponse> {
    const authentication = await this.cognitoService.signInWithPassword(
      input.email,
      input.password,
    );

    if (!authentication.idToken || !authentication.refreshToken) {
      this.authCookieService.clearAuthCookies(response);
      throw unauthorized();
    }

    const [accessClaims, idClaims] = await Promise.all([
      this.tokenVerifier.verifyAccessToken(authentication.accessToken),
      this.tokenVerifier.verifyIdToken(authentication.idToken),
    ]);

    if (accessClaims.sub !== idClaims.sub) {
      throw unauthorized();
    }

    const user = await this.usersService.upsertFromCognito({
      cognitoSub: idClaims.sub,
      email: idClaims.email ?? input.email,
      ...(idClaims.name !== undefined ? { displayName: idClaims.name } : {}),
    });

    await this.organizationsService.provisionPersonalOrganization(
      user.id,
      user.email,
    );

    this.authCookieService.setAccessToken(response, authentication.accessToken);
    if (authentication.refreshToken) {
      this.authCookieService.setRefreshToken(
        response,
        authentication.refreshToken,
      );
    }
    if (this.configuration?.clientSecret) {
      this.authCookieService.setCognitoUsername(response, input.email);
    }

    return { user: toSafeUser(user) };
  }

  async refresh(
    request: Request,
    response: Response,
  ): Promise<SafeSessionResponse> {
    const cookies = getCookies(request);
    const refreshToken = getCookie(cookies, AUTH_COOKIE_NAMES.refreshToken);
    const username = getCookie(cookies, AUTH_COOKIE_NAMES.cognitoUsername);

    if (!refreshToken) {
      this.authCookieService.clearAuthCookies(response);
      throw unauthorized();
    }

    if (this.configuration?.clientSecret && !username) {
      this.authCookieService.clearAuthCookies(response);
      throw unauthorized();
    }

    try {
      const authentication = username
        ? await this.cognitoService.refreshToken(refreshToken, username)
        : await this.cognitoService.refreshToken(refreshToken);
      const accessClaims = await this.tokenVerifier.verifyAccessToken(
        authentication.accessToken,
      );
      const user = await this.usersService.findByCognitoSub(accessClaims.sub);

      if (!user) {
        throw unauthorized();
      }

      this.authCookieService.setAccessToken(
        response,
        authentication.accessToken,
      );
      if (authentication.refreshToken) {
        this.authCookieService.setRefreshToken(
          response,
          authentication.refreshToken,
        );
      }

      return { user: toSafeUser(user) };
    } catch (error) {
      this.authCookieService.clearAuthCookies(response);
      throw error;
    }
  }

  async logout(request: Request, response: Response): Promise<void> {
    try {
      const refreshToken = getCookie(
        getCookies(request),
        AUTH_COOKIE_NAMES.refreshToken,
      );
      if (refreshToken) {
        await this.cognitoService.revokeToken(refreshToken);
      }
    } catch {
      // Remote revocation is best effort; local cookie cleanup always wins.
    } finally {
      this.authCookieService.clearAuthCookies(response);
    }
  }

  async getCurrentSession(principal: AuthenticatedUser): Promise<MeResponse> {
    const user = await this.usersService.findByCognitoSub(principal.cognitoSub);
    if (!user) {
      throw unauthorized();
    }

    const safeUser = toSafeUser(user);
    const cacheKey = `${ME_CACHE_PREFIX}${user.id}`;
    const cached = await this.cacheService
      .get<MeResponse>(cacheKey)
      .catch(() => null);

    const normalizedCached = normalizeCachedMeResponse(cached, user.id);
    if (normalizedCached) {
      return normalizedCached;
    }

    const organizations = (
      await this.organizationsService.findForUser(user.id)
    ).map(toSafeOrganization);
    const result: MeResponse = { user: safeUser, organizations };
    await this.cacheService
      .set(cacheKey, result, ME_CACHE_TTL_SECONDS)
      .catch(() => undefined);

    return result;
  }
}

function registrationResponse(
  email: string,
  registration: CognitoRegistrationResult,
): RegistrationResponse {
  return {
    status: registration.userConfirmed ? 'CONFIRMED' : 'CONFIRMATION_REQUIRED',
    email,
    ...(registration.codeDeliveryDetails?.destination
      ? { destination: registration.codeDeliveryDetails.destination }
      : {}),
  };
}

function toSafeUser(user: LocalUser): SafeUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  };
}

function getCookies(request: Request): Record<string, unknown> {
  const cookies = (request as Request & { cookies?: unknown }).cookies;
  return typeof cookies === 'object' && cookies !== null
    ? (cookies as Record<string, unknown>)
    : {};
}

function getCookie(
  cookies: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = cookies[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toSafeOrganization(
  organization: OrganizationWithRole,
): OrganizationWithRole {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role: organization.role,
  };
}

function normalizeCachedMeResponse(
  value: unknown,
  userId: string,
): MeResponse | null {
  if (!isRecord(value) || !isRecord(value.user)) {
    return null;
  }

  const cachedUser = value.user;
  if (
    cachedUser.id !== userId ||
    typeof cachedUser.email !== 'string' ||
    (cachedUser.displayName !== null &&
      typeof cachedUser.displayName !== 'string') ||
    !Array.isArray(value.organizations)
  ) {
    return null;
  }

  const organizations = value.organizations.map(normalizeCachedOrganization);
  if (organizations.some((organization) => organization === null)) {
    return null;
  }

  return {
    user: {
      id: cachedUser.id,
      email: cachedUser.email,
      displayName: cachedUser.displayName,
    },
    organizations: organizations as OrganizationWithRole[],
  };
}

function normalizeCachedOrganization(
  value: unknown,
): OrganizationWithRole | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.slug !== 'string' ||
    !isRole(value.role)
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    slug: value.slug,
    role: value.role,
  };
}

function isRole(value: unknown): value is OrganizationWithRole['role'] {
  return value === 'ADMIN' || value === 'OPERATOR' || value === 'VIEWER';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException(AUTH_UNAUTHORIZED_RESPONSE);
}
