import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_COOKIE_NAMES,
  AUTH_COOKIE_OPTIONS,
} from '../../common/constants/auth.constants.js';
import { AuthCookieService } from './auth-cookie.service.js';

type ResponseDouble = {
  cookie: ReturnType<typeof vi.fn>;
  clearCookie: ReturnType<typeof vi.fn>;
};

function createResponseDouble(): ResponseDouble {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
}

describe('AuthCookieService', () => {
  it('sets development cookies with secure attributes and configured lifetimes', () => {
    const response = createResponseDouble();
    const service = new AuthCookieService({
      nodeEnv: 'development',
      sameSite: 'strict',
      accessMaxAge: 15_000,
      refreshMaxAge: 120_000,
      usernameMaxAge: 120_000,
    });

    service.setAccessToken(response as unknown as Response, 'access-token');
    service.setRefreshToken(response as unknown as Response, 'refresh-token');
    service.setCognitoUsername(
      response as unknown as Response,
      'alice@example.com',
    );

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      AUTH_COOKIE_NAMES.accessToken,
      'access-token',
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        path: '/',
        maxAge: 15_000,
      }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      AUTH_COOKIE_NAMES.refreshToken,
      'refresh-token',
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        path: '/',
        maxAge: 120_000,
      }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      3,
      AUTH_COOKIE_NAMES.cognitoUsername,
      'alice@example.com',
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        path: '/',
        maxAge: 120_000,
      }),
    );
  });

  it('sets secure cookies in production and keeps cookie options centralized', () => {
    const response = createResponseDouble();
    const service = new AuthCookieService({
      nodeEnv: 'production',
      secure: false,
    });

    service.setAccessToken(response as unknown as Response, 'access-token');

    expect(response.cookie).toHaveBeenCalledWith(
      AUTH_COOKIE_NAMES.accessToken,
      'access-token',
      expect.objectContaining({
        ...AUTH_COOKIE_OPTIONS,
        secure: true,
      }),
    );
  });

  it('reads string max ages from ConfigService and keeps production secure', () => {
    const response = createResponseDouble();
    const values: Record<string, unknown> = {
      'app.nodeEnv': 'production',
      'auth.cookies.sameSite': 'strict',
      'auth.cookies.accessMaxAge': '1000',
      'auth.cookies.refreshMaxAge': '2000',
      'auth.cookies.usernameMaxAge': '3000',
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService;
    const service = new AuthCookieService(config);

    service.setAccessToken(response as unknown as Response, 'access-token');
    service.setRefreshToken(response as unknown as Response, 'refresh-token');
    service.setCognitoUsername(
      response as unknown as Response,
      'alice@example.com',
    );

    expect(response.cookie).toHaveBeenNthCalledWith(
      1,
      AUTH_COOKIE_NAMES.accessToken,
      'access-token',
      expect.objectContaining({
        secure: true,
        sameSite: 'strict',
        maxAge: 1000,
      }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      2,
      AUTH_COOKIE_NAMES.refreshToken,
      'refresh-token',
      expect.objectContaining({
        secure: true,
        sameSite: 'strict',
        maxAge: 2000,
      }),
    );
    expect(response.cookie).toHaveBeenNthCalledWith(
      3,
      AUTH_COOKIE_NAMES.cognitoUsername,
      'alice@example.com',
      expect.objectContaining({
        secure: true,
        sameSite: 'strict',
        maxAge: 3000,
      }),
    );
  });

  it('clears access, refresh, and username cookies with matching safe attributes', () => {
    const response = createResponseDouble();
    const service = new AuthCookieService({
      nodeEnv: 'production',
      sameSite: 'lax',
      accessMaxAge: 10,
      refreshMaxAge: 20,
      usernameMaxAge: 30,
    });

    service.clearAuthCookies(response as unknown as Response);

    expect(response.clearCookie).toHaveBeenCalledTimes(3);
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      1,
      AUTH_COOKIE_NAMES.accessToken,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      }),
    );
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      2,
      AUTH_COOKIE_NAMES.refreshToken,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      }),
    );
    expect(response.clearCookie).toHaveBeenNthCalledWith(
      3,
      AUTH_COOKIE_NAMES.cognitoUsername,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      }),
    );
  });
});
