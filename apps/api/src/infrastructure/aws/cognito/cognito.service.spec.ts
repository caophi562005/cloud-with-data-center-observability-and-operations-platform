import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RevokeTokenCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../../../config/auth.config.js';
import { CognitoSecretHashService } from './cognito-secret-hash.service.js';
import { CognitoService } from './cognito.service.js';

const confidentialConfig: AuthConfig = {
  region: 'ap-southeast-1',
  userPoolId: 'ap-southeast-1_example',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

function createService(config: AuthConfig = confidentialConfig) {
  const send = vi.fn();
  const client = { send } as unknown as CognitoIdentityProviderClient;
  const secretHashService = new CognitoSecretHashService(config);
  const service = new CognitoService(config, client, secretHashService);

  return { send, service };
}

describe('CognitoService', () => {
  it('signs up with email and display name and maps code delivery safely', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({
      UserConfirmed: false,
      CodeDeliveryDetails: {
        AttributeName: 'email',
        DeliveryMedium: 'EMAIL',
        Destination: 'a***@example.com',
      },
    });

    await expect(
      service.signUp('person@example.com', 'Correct-Horse-123', 'Person'),
    ).resolves.toEqual({
      userConfirmed: false,
      codeDeliveryDetails: {
        attributeName: 'email',
        deliveryMedium: 'EMAIL',
        destination: 'a***@example.com',
      },
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SignUpCommand);
    expect(command.input).toEqual({
      ClientId: 'client-id',
      Username: 'person@example.com',
      Password: 'Correct-Horse-123',
      SecretHash: '6ASJ19bsN05kYwCegWSSsmTc/sDnaRTyyP1y/MTI8g0=',
      UserAttributes: [
        { Name: 'email', Value: 'person@example.com' },
        { Name: 'name', Value: 'Person' },
      ],
    });
  });

  it('confirms a signup with the email confirmation code', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({});

    await expect(
      service.confirmSignUp('person@example.com', '123456'),
    ).resolves.toBeUndefined();

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConfirmSignUpCommand);
    expect(command.input).toEqual({
      ClientId: 'client-id',
      Username: 'person@example.com',
      ConfirmationCode: '123456',
      SecretHash: '6ASJ19bsN05kYwCegWSSsmTc/sDnaRTyyP1y/MTI8g0=',
    });
  });

  it('resends a signup confirmation code with safe delivery details', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({
      CodeDeliveryDetails: {
        AttributeName: 'email',
        DeliveryMedium: 'EMAIL',
        Destination: 'a***@example.com',
      },
    });

    await expect(
      service.resendConfirmationCode('person@example.com'),
    ).resolves.toEqual({
      attributeName: 'email',
      deliveryMedium: 'EMAIL',
      destination: 'a***@example.com',
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ResendConfirmationCodeCommand);
    expect(command.input).toEqual({
      ClientId: 'client-id',
      Username: 'person@example.com',
      SecretHash: '6ASJ19bsN05kYwCegWSSsmTc/sDnaRTyyP1y/MTI8g0=',
    });
  });

  it('maps pending signup and invalid confirmation errors safely', async () => {
    const { send, service } = createService();
    send.mockRejectedValueOnce({ name: 'UsernameExistsException' });

    await expect(
      service.signUp('person@example.com', 'Correct-Horse-123', 'Person'),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_REGISTRATION_PENDING',
        message: 'Registration may already be pending',
      },
    });

    send.mockRejectedValueOnce({ name: 'CodeMismatchException' });
    await expect(
      service.confirmSignUp('person@example.com', '123456'),
    ).rejects.toMatchObject({
      response: {
        code: 'AUTH_CONFIRMATION_INVALID',
        message: 'Confirmation code is invalid or expired',
      },
    });
  });

  it('uses USER_PASSWORD_AUTH and maps the safe authentication result', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: 'access-token',
        IdToken: 'id-token',
        RefreshToken: 'refresh-token',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });

    await expect(
      service.signInWithPassword('admin@example.com', 'password'),
    ).resolves.toEqual({
      accessToken: 'access-token',
      idToken: 'id-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(InitiateAuthCommand);
    expect(command.input).toEqual({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: 'client-id',
      AuthParameters: {
        USERNAME: 'admin@example.com',
        PASSWORD: 'password',
        SECRET_HASH: '98ZPVquY3OpS4HbTpuMB2BzhAXqjhGV7aWQR/+YRV+A=',
      },
    });
  });

  it('omits SECRET_HASH for a public client', async () => {
    const { send, service } = createService({
      ...confidentialConfig,
      clientSecret: undefined,
    });
    send.mockResolvedValue({
      AuthenticationResult: { AccessToken: 'access-token' },
    });

    await service.signInWithPassword('admin@example.com', 'password');

    const command = send.mock.calls[0]?.[0];
    expect(command.input.AuthParameters).toEqual({
      USERNAME: 'admin@example.com',
      PASSWORD: 'password',
    });
  });

  it('uses REFRESH_TOKEN_AUTH and conditionally adds username and secret hash', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({
      AuthenticationResult: {
        AccessToken: 'new-access-token',
        IdToken: 'new-id-token',
        ExpiresIn: 1800,
      },
    });

    await expect(
      service.refreshToken('refresh-token', 'admin@example.com'),
    ).resolves.toEqual({
      accessToken: 'new-access-token',
      idToken: 'new-id-token',
      expiresIn: 1800,
    });

    const command = send.mock.calls[0]?.[0];
    expect(command.input).toEqual({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: 'client-id',
      AuthParameters: {
        REFRESH_TOKEN: 'refresh-token',
        USERNAME: 'admin@example.com',
        SECRET_HASH: '98ZPVquY3OpS4HbTpuMB2BzhAXqjhGV7aWQR/+YRV+A=',
      },
    });
  });

  it('does not guess a username when refreshing without one', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({
      AuthenticationResult: { AccessToken: 'new-access-token' },
    });

    await service.refreshToken('refresh-token');

    const command = send.mock.calls[0]?.[0];
    expect(command.input.AuthParameters).toEqual({
      REFRESH_TOKEN: 'refresh-token',
    });
  });

  it('revokes a refresh token with RevokeTokenCommand', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({});

    await expect(service.revokeToken('refresh-token')).resolves.toBeUndefined();

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(RevokeTokenCommand);
    expect(command.input).toEqual({
      Token: 'refresh-token',
      ClientId: 'client-id',
      ClientSecret: 'client-secret',
    });
  });

  it('maps login SDK failures to a safe invalid-credentials error', async () => {
    const { send, service } = createService();
    send.mockRejectedValue(
      new Error(
        'NotAuthorizedException awsRequestId=aws-secret token=password',
      ),
    );

    const error = await service
      .signInWithPassword('admin@example.com', 'password')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid credentials',
    });
    expect((error as Error).message).not.toContain('aws-secret');
    expect((error as Error).message).not.toContain('password');
  });

  it('maps a login response without an access token to a safe error', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({ AuthenticationResult: { IdToken: 'id-token' } });

    const error = await service
      .signInWithPassword('admin@example.com', 'password')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid credentials',
    });
  });

  it('maps refresh SDK failures to a safe unauthorized error', async () => {
    const { send, service } = createService();
    send.mockRejectedValue(
      new Error(
        'NotAuthorizedException awsRequestId=aws-secret token=refresh-token',
      ),
    );

    const error = await service
      .refreshToken('refresh-token', 'admin@example.com')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: 'AUTH_UNAUTHORIZED',
      message: 'Authentication required',
    });
    expect((error as Error).message).not.toContain('aws-secret');
    expect((error as Error).message).not.toContain('refresh-token');
  });

  it('maps a refresh response without an access token to a safe unauthorized error', async () => {
    const { send, service } = createService();
    send.mockResolvedValue({ AuthenticationResult: { IdToken: 'id-token' } });

    const error = await service
      .refreshToken('refresh-token', 'admin@example.com')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({
      code: 'AUTH_UNAUTHORIZED',
      message: 'Authentication required',
    });
  });

  it('swallows revoke failures without exposing SDK details', async () => {
    const { send, service } = createService();
    send.mockRejectedValue(
      new Error('AWS request id aws-secret token=refresh-token'),
    );

    await expect(service.revokeToken('refresh-token')).resolves.toBeUndefined();
  });
});
