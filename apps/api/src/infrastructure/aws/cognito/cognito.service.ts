import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RevokeTokenCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { authConfig, type AuthConfig } from '../../../config/auth.config.js';
import { COGNITO_AUTH_FLOWS, COGNITO_CLIENT } from './cognito.constants.js';
import type { CognitoAuthenticationResult } from './cognito.types.js';
import { CognitoSecretHashService } from './cognito-secret-hash.service.js';

@Injectable()
export class CognitoService {
  constructor(
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    @Inject(COGNITO_CLIENT)
    private readonly client: CognitoIdentityProviderClient,
    private readonly secretHashService: CognitoSecretHashService,
  ) {}

  async signInWithPassword(
    email: string,
    password: string,
  ): Promise<CognitoAuthenticationResult> {
    const authParameters: Record<string, string> = {
      USERNAME: email,
      PASSWORD: password,
    };
    this.addSecretHash(authParameters, email);

    try {
      const response = await this.client.send(
        new InitiateAuthCommand({
          AuthFlow: COGNITO_AUTH_FLOWS.password,
          ClientId: this.config.clientId,
          AuthParameters: authParameters,
        }),
      );

      return this.mapAuthenticationResult(
        response.AuthenticationResult,
        'login',
      );
    } catch {
      throw this.authenticationFailure('login');
    }
  }

  async refreshToken(
    refreshToken: string,
    username?: string,
  ): Promise<CognitoAuthenticationResult> {
    const authParameters: Record<string, string> = {
      REFRESH_TOKEN: refreshToken,
    };

    if (username) {
      authParameters.USERNAME = username;
      this.addSecretHash(authParameters, username);
    }

    try {
      const response = await this.client.send(
        new InitiateAuthCommand({
          AuthFlow: COGNITO_AUTH_FLOWS.refresh,
          ClientId: this.config.clientId,
          AuthParameters: authParameters,
        }),
      );

      return this.mapAuthenticationResult(
        response.AuthenticationResult,
        'refresh',
      );
    } catch {
      throw this.authenticationFailure('refresh');
    }
  }

  async revokeToken(refreshToken: string): Promise<void> {
    try {
      await this.client.send(
        new RevokeTokenCommand({
          Token: refreshToken,
          ClientId: this.config.clientId,
          ...(this.config.clientSecret
            ? { ClientSecret: this.config.clientSecret }
            : {}),
        }),
      );
    } catch {
      // Revocation is best effort; callers still clear local auth state.
    }
  }

  private addSecretHash(
    authParameters: Record<string, string>,
    username: string,
  ): void {
    const secretHash = this.secretHashService.calculate(username);
    if (secretHash) {
      authParameters.SECRET_HASH = secretHash;
    }
  }

  private mapAuthenticationResult(
    result: AuthenticationResultType | undefined,
    flow: 'login' | 'refresh',
  ): CognitoAuthenticationResult {
    if (!result?.AccessToken) {
      throw this.authenticationFailure(flow);
    }

    return {
      accessToken: result.AccessToken,
      ...(result.IdToken ? { idToken: result.IdToken } : {}),
      ...(result.RefreshToken ? { refreshToken: result.RefreshToken } : {}),
      ...(result.ExpiresIn !== undefined
        ? { expiresIn: result.ExpiresIn }
        : {}),
    };
  }

  private authenticationFailure(
    flow: 'login' | 'refresh',
  ): UnauthorizedException {
    return new UnauthorizedException(
      flow === 'login'
        ? {
            code: 'AUTH_INVALID_CREDENTIALS',
            message: 'Invalid credentials',
          }
        : {
            code: 'AUTH_UNAUTHORIZED',
            message: 'Authentication required',
          },
    );
  }
}
