export type CognitoAuthenticationResult = {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresIn?: number;
};

export type CognitoCodeDeliveryDetails = {
  attributeName?: string;
  deliveryMedium?: string;
  destination?: string;
};

export type CognitoRegistrationResult = {
  userConfirmed: boolean;
  codeDeliveryDetails?: CognitoCodeDeliveryDetails;
};

export type CognitoAccessTokenClaims = {
  sub: string;
  client_id: string;
  token_use: 'access';
  scope?: string;
  username?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  [claim: string]: unknown;
};

export type CognitoIdTokenClaims = {
  sub: string;
  aud: string;
  token_use: 'id';
  email?: string;
  name?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  [claim: string]: unknown;
};

export interface CognitoJwtVerifierLike {
  verify(token: string): Promise<unknown>;
}
