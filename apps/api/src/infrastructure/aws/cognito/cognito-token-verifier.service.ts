import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  COGNITO_ACCESS_TOKEN_VERIFIER,
  COGNITO_ID_TOKEN_VERIFIER,
  COGNITO_TOKEN_VERIFICATION_ERROR,
} from './cognito.constants.js';
import type {
  CognitoAccessTokenClaims,
  CognitoIdTokenClaims,
  CognitoJwtVerifierLike,
} from './cognito.types.js';

@Injectable()
export class CognitoTokenVerifierService {
  constructor(
    @Inject(COGNITO_ACCESS_TOKEN_VERIFIER)
    private readonly accessTokenVerifier: CognitoJwtVerifierLike,
    @Inject(COGNITO_ID_TOKEN_VERIFIER)
    private readonly idTokenVerifier: CognitoJwtVerifierLike,
  ) {}

  verifyAccessToken(token: string): Promise<CognitoAccessTokenClaims> {
    return this.verify<CognitoAccessTokenClaims>(
      this.accessTokenVerifier,
      token,
    );
  }

  verifyIdToken(token: string): Promise<CognitoIdTokenClaims> {
    return this.verify<CognitoIdTokenClaims>(this.idTokenVerifier, token);
  }

  private async verify<T>(
    verifier: CognitoJwtVerifierLike,
    token: string,
  ): Promise<T> {
    try {
      return (await verifier.verify(token)) as T;
    } catch {
      throw new UnauthorizedException(COGNITO_TOKEN_VERIFICATION_ERROR);
    }
  }
}
