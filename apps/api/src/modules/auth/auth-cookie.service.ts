import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import {
  AUTH_COOKIE_MAX_AGES,
  AUTH_COOKIE_NAMES,
  AUTH_COOKIE_OPTIONS,
} from '../../common/constants/auth.constants.js';

export type AuthCookieSameSite = NonNullable<CookieOptions['sameSite']>;
type NumericCookieOption = number | string;

export interface AuthCookieServiceOptions {
  nodeEnv?: 'development' | 'test' | 'production';
  environment?: 'development' | 'test' | 'production';
  secure?: boolean;
  sameSite?: AuthCookieSameSite;
  accessMaxAge?: NumericCookieOption;
  refreshMaxAge?: NumericCookieOption;
  usernameMaxAge?: NumericCookieOption;
  cookies?: {
    sameSite?: AuthCookieSameSite;
    accessMaxAge?: NumericCookieOption;
    refreshMaxAge?: NumericCookieOption;
    usernameMaxAge?: NumericCookieOption;
  };
}

type ConfigLike = {
  get<T = unknown>(propertyPath: string, defaultValue?: T): T | undefined;
};

type CookieSettings = {
  secure: boolean;
  sameSite: AuthCookieSameSite;
  accessMaxAge: number;
  refreshMaxAge: number;
  usernameMaxAge: number;
};

function isConfigLike(value: unknown): value is ConfigLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ConfigLike).get === 'function'
  );
}

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : fallback;
  }

  return fallback;
}

function asSameSite(
  value: unknown,
  fallback: AuthCookieSameSite,
): AuthCookieSameSite {
  if (value === true || value === false) {
    return value;
  }

  if (value === 'strict' || value === 'lax' || value === 'none') {
    return value;
  }

  return fallback;
}

function fromConfig(config: ConfigLike): CookieSettings {
  const get = <T>(...paths: string[]): T | undefined => {
    for (const path of paths) {
      const value = config.get<T>(path);
      if (value !== undefined) {
        return value;
      }
    }

    return undefined;
  };

  const nodeEnv = get<string>('app.nodeEnv', 'NODE_ENV') ?? 'development';
  const sameSite = asSameSite(
    get<AuthCookieSameSite>(
      'auth.cookies.sameSite',
      'auth.cookie.sameSite',
      'auth.sameSite',
      'AUTH_COOKIE_SAME_SITE',
    ),
    AUTH_COOKIE_OPTIONS.sameSite,
  );

  return {
    secure: nodeEnv === 'production',
    sameSite,
    accessMaxAge: asPositiveInteger(
      get<number>(
        'auth.cookies.accessMaxAge',
        'auth.cookie.accessMaxAge',
        'auth.accessMaxAge',
        'AUTH_ACCESS_COOKIE_MAX_AGE',
      ),
      AUTH_COOKIE_MAX_AGES.accessToken,
    ),
    refreshMaxAge: asPositiveInteger(
      get<number>(
        'auth.cookies.refreshMaxAge',
        'auth.cookie.refreshMaxAge',
        'auth.refreshMaxAge',
        'AUTH_REFRESH_COOKIE_MAX_AGE',
      ),
      AUTH_COOKIE_MAX_AGES.refreshToken,
    ),
    usernameMaxAge: asPositiveInteger(
      get<number>(
        'auth.cookies.usernameMaxAge',
        'auth.cookie.usernameMaxAge',
        'auth.usernameMaxAge',
        'AUTH_USERNAME_COOKIE_MAX_AGE',
      ),
      AUTH_COOKIE_MAX_AGES.cognitoUsername,
    ),
  };
}

function fromOptions(options: AuthCookieServiceOptions): CookieSettings {
  const nested = options.cookies ?? {};
  const nodeEnv = options.nodeEnv ?? options.environment ?? 'development';

  return {
    secure: nodeEnv === 'production' ? true : (options.secure ?? false),
    sameSite: asSameSite(
      options.sameSite ?? nested.sameSite,
      AUTH_COOKIE_OPTIONS.sameSite,
    ),
    accessMaxAge: asPositiveInteger(
      options.accessMaxAge ?? nested.accessMaxAge,
      AUTH_COOKIE_MAX_AGES.accessToken,
    ),
    refreshMaxAge: asPositiveInteger(
      options.refreshMaxAge ?? nested.refreshMaxAge,
      AUTH_COOKIE_MAX_AGES.refreshToken,
    ),
    usernameMaxAge: asPositiveInteger(
      options.usernameMaxAge ?? nested.usernameMaxAge,
      AUTH_COOKIE_MAX_AGES.cognitoUsername,
    ),
  };
}

@Injectable()
export class AuthCookieService {
  private readonly settings: CookieSettings;

  constructor(
    @Optional()
    @Inject(ConfigService)
    configOrOptions?: ConfigService | AuthCookieServiceOptions,
  ) {
    this.settings = isConfigLike(configOrOptions)
      ? fromConfig(configOrOptions)
      : fromOptions(configOrOptions ?? {});
  }

  setAccessToken(response: Response, token: string): void {
    this.setCookie(
      response,
      AUTH_COOKIE_NAMES.accessToken,
      token,
      this.settings.accessMaxAge,
    );
  }

  setRefreshToken(response: Response, token: string): void {
    this.setCookie(
      response,
      AUTH_COOKIE_NAMES.refreshToken,
      token,
      this.settings.refreshMaxAge,
    );
  }

  setCognitoUsername(response: Response, username: string): void {
    this.setCookie(
      response,
      AUTH_COOKIE_NAMES.cognitoUsername,
      username,
      this.settings.usernameMaxAge,
    );
  }

  clearAccessToken(response: Response): void {
    this.clearCookie(response, AUTH_COOKIE_NAMES.accessToken);
  }

  clearRefreshToken(response: Response): void {
    this.clearCookie(response, AUTH_COOKIE_NAMES.refreshToken);
  }

  clearCognitoUsername(response: Response): void {
    this.clearCookie(response, AUTH_COOKIE_NAMES.cognitoUsername);
  }

  clearAuthCookies(response: Response): void {
    this.clearAccessToken(response);
    this.clearRefreshToken(response);
    this.clearCognitoUsername(response);
  }

  private setCookie(
    response: Response,
    name: string,
    value: string,
    maxAge: number,
  ): void {
    response.cookie(name, value, this.cookieOptions(maxAge));
  }

  private clearCookie(response: Response, name: string): void {
    response.clearCookie(name, this.cookieOptions(0));
  }

  private cookieOptions(maxAge: number): CookieOptions {
    return {
      ...AUTH_COOKIE_OPTIONS,
      secure: this.settings.secure,
      sameSite: this.settings.sameSite,
      maxAge,
    };
  }
}
