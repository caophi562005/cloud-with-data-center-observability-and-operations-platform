import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RevokeTokenCommand,
  SignUpCommand,
  type AuthenticationResultType,
} from '@aws-sdk/client-cognito-identity-provider';
import { authConfig, type AuthConfig } from '../../../config/auth.config.js';
import { COGNITO_AUTH_FLOWS, COGNITO_CLIENT } from './cognito.constants.js';
import type {
  CognitoAuthenticationResult,
  CognitoCodeDeliveryDetails,
  CognitoRegistrationResult,
} from './cognito.types.js';
import { CognitoSecretHashService } from './cognito-secret-hash.service.js';

@Injectable()
export class CognitoService {
  constructor(
    @Inject(authConfig.KEY) private readonly config: AuthConfig,
    @Inject(COGNITO_CLIENT)
    private readonly client: CognitoIdentityProviderClient,
    private readonly secretHashService: CognitoSecretHashService,
  ) {}

  async signUp(
    email: string,
    password: string,
    displayName: string,
  ): Promise<CognitoRegistrationResult> {
    try {
      const response = await this.client.send(
        new SignUpCommand({
          ClientId: this.config.clientId,
          Username: email,
          Password: password,
          ...this.secretHashInput(email),
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'name', Value: displayName },
          ],
        }),
      );

      const codeDeliveryDetails = mapCodeDeliveryDetails(
        response.CodeDeliveryDetails,
      );

      return {
        userConfirmed: response.UserConfirmed === true,
        ...(codeDeliveryDetails ? { codeDeliveryDetails } : {}),
      };
    } catch (error) {
      throw this.registrationFailure(error, 'signup');
    }
  }

  async confirmSignUp(email: string, confirmationCode: string): Promise<void> {
    try {
      await this.client.send(
        new ConfirmSignUpCommand({
          ClientId: this.config.clientId,
          Username: email,
          ConfirmationCode: confirmationCode,
          ...this.secretHashInput(email),
        }),
      );
    } catch (error) {
      throw this.registrationFailure(error, 'confirmation');
    }
  }

  async resendConfirmationCode(
    email: string,
  ): Promise<CognitoCodeDeliveryDetails | undefined> {
    try {
      const response = await this.client.send(
        new ResendConfirmationCodeCommand({
          ClientId: this.config.clientId,
          Username: email,
          ...this.secretHashInput(email),
        }),
      );

      return mapCodeDeliveryDetails(response.CodeDeliveryDetails);
    } catch (error) {
      throw this.registrationFailure(error, 'resend');
    }
  }

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

  private secretHashInput(username: string): { SecretHash?: string } {
    const secretHash = this.secretHashService.calculate(username);
    return secretHash ? { SecretHash: secretHash } : {};
  }

  private registrationFailure(
    error: unknown,
    flow: 'signup' | 'confirmation' | 'resend',
  ): Error {
    const name = errorName(error);

    if (name === 'UsernameExistsException') {
      return new ConflictException({
        code: 'AUTH_REGISTRATION_PENDING',
        message: 'Registration may already be pending',
      });
    }

    if (
      name === 'CodeMismatchException' ||
      name === 'ExpiredCodeException' ||
      (flow === 'confirmation' && name === 'NotAuthorizedException')
    ) {
      return new BadRequestException({
        code: 'AUTH_CONFIRMATION_INVALID',
        message: 'Confirmation code is invalid or expired',
      });
    }

    if (
      name === 'LimitExceededException' ||
      name === 'TooManyRequestsException'
    ) {
      return new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      name === 'InvalidPasswordException' ||
      name === 'InvalidParameterException'
    ) {
      return new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
      });
    }

    return new BadRequestException({
      code: 'AUTH_REGISTRATION_FAILED',
      message: 'Registration could not be completed',
    });
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

function mapCodeDeliveryDetails(
  details:
    | {
        AttributeName?: string;
        DeliveryMedium?: string;
        Destination?: string;
      }
    | undefined,
): CognitoCodeDeliveryDetails | undefined {
  if (!details) {
    return undefined;
  }

  return {
    ...(details.AttributeName ? { attributeName: details.AttributeName } : {}),
    ...(details.DeliveryMedium
      ? { deliveryMedium: details.DeliveryMedium }
      : {}),
    ...(details.Destination ? { destination: details.Destination } : {}),
  };
}

function errorName(error: unknown): string | undefined {
  return isRecord(error) && typeof error.name === 'string'
    ? error.name
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
