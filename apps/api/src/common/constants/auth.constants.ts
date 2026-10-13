import type { CookieOptions } from 'express';

export const AUTH_COOKIE_NAMES = {
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  cognitoUsername: 'cognito_username',
} as const;

/** Shared, environment-independent cookie attributes. */
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  path: '/',
  sameSite: 'lax',
} satisfies Pick<CookieOptions, 'httpOnly' | 'path' | 'sameSite'>;

export const AUTH_COOKIE_MAX_AGES = {
  accessToken: 15 * 60 * 1_000,
  refreshToken: 30 * 24 * 60 * 60 * 1_000,
  cognitoUsername: 30 * 24 * 60 * 60 * 1_000,
} as const;
