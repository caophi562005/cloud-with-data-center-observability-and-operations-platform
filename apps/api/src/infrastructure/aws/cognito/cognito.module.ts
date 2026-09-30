import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { authConfig, type AuthConfig } from '../../../config/auth.config.js';
import {
  COGNITO_ACCESS_TOKEN_VERIFIER,
  COGNITO_CLIENT,
  COGNITO_ID_TOKEN_VERIFIER,
  COGNITO_TOKEN_USES,
} from './cognito.constants.js';
import { CognitoSecretHashService } from './cognito-secret-hash.service.js';
import { CognitoService } from './cognito.service.js';
import { CognitoTokenVerifierService } from './cognito-token-verifier.service.js';

@Module({
  imports: [ConfigModule.forFeature(authConfig)],
  providers: [
    {
      provide: COGNITO_CLIENT,
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) =>
        new CognitoIdentityProviderClient({ region: config.region }),
    },
    {
      provide: COGNITO_ACCESS_TOKEN_VERIFIER,
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) =>
        CognitoJwtVerifier.create({
          userPoolId: config.userPoolId,
          clientId: config.clientId,
          tokenUse: COGNITO_TOKEN_USES.access,
        }),
    },
    {
      provide: COGNITO_ID_TOKEN_VERIFIER,
      inject: [authConfig.KEY],
      useFactory: (config: AuthConfig) =>
        CognitoJwtVerifier.create({
          userPoolId: config.userPoolId,
          clientId: config.clientId,
          tokenUse: COGNITO_TOKEN_USES.id,
        }),
    },
    CognitoSecretHashService,
    CognitoService,
    CognitoTokenVerifierService,
  ],
  exports: [
    CognitoSecretHashService,
    CognitoService,
    CognitoTokenVerifierService,
  ],
})
export class CognitoModule {}
