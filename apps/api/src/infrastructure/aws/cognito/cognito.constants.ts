export const COGNITO_CLIENT = Symbol('COGNITO_CLIENT');
export const COGNITO_ACCESS_TOKEN_VERIFIER = Symbol(
  'COGNITO_ACCESS_TOKEN_VERIFIER',
);
export const COGNITO_ID_TOKEN_VERIFIER = Symbol('COGNITO_ID_TOKEN_VERIFIER');

export const COGNITO_AUTH_FLOWS = {
  password: 'USER_PASSWORD_AUTH',
  refresh: 'REFRESH_TOKEN_AUTH',
} as const;

export const COGNITO_TOKEN_USES = {
  access: 'access',
  id: 'id',
} as const;

export const COGNITO_TOKEN_VERIFICATION_ERROR =
  'Unable to verify Cognito token';
