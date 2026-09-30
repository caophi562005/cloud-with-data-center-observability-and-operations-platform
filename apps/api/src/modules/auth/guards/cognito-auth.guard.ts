import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { AUTH_COOKIE_NAMES } from '../../../common/constants/auth.constants.js';
import type { RequestContext } from '../../../common/types/request-context.type.js';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type.js';
import { CognitoTokenVerifierService } from '../../../infrastructure/aws/cognito/cognito-token-verifier.service.js';

const AUTH_UNAUTHORIZED_RESPONSE = {
  code: 'AUTH_UNAUTHORIZED',
  message: 'Authentication required',
} as const;

@Injectable()
export class CognitoAuthGuard implements CanActivate {
  constructor(private readonly tokenVerifier: CognitoTokenVerifierService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestContext>();
    const accessToken = readAccessToken(request);

    if (!accessToken) {
      throw unauthorized();
    }

    try {
      const claims = await this.tokenVerifier.verifyAccessToken(accessToken);
      if (
        claims.token_use !== 'access' ||
        typeof claims.sub !== 'string' ||
        typeof claims.client_id !== 'string'
      ) {
        throw unauthorized();
      }

      const principal: AuthenticatedUser = {
        cognitoSub: claims.sub,
        clientId: claims.client_id,
        ...(typeof claims.scope === 'string' ? { scope: claims.scope } : {}),
        tokenUse: 'access',
      };
      request.user = principal;
      return true;
    } catch {
      throw unauthorized();
    }
  }
}

function readAccessToken(request: RequestContext): string | undefined {
  const cookies = (request as RequestContext & { cookies?: unknown }).cookies;
  if (typeof cookies !== 'object' || cookies === null) {
    return undefined;
  }

  const value = (cookies as Record<string, unknown>)[
    AUTH_COOKIE_NAMES.accessToken
  ];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException(AUTH_UNAUTHORIZED_RESPONSE);
}
