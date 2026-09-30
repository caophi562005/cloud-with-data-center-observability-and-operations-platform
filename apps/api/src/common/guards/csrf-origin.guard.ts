import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RequestContext } from '../types/request-context.type.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_ERROR = {
  code: 'AUTH_FORBIDDEN',
  message: 'Request origin is not allowed',
} as const;

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  private readonly nodeEnv: string;
  private readonly webOrigin: string;

  constructor(configService: ConfigService) {
    this.nodeEnv = configService.getOrThrow<string>('app.nodeEnv');
    this.webOrigin = toOrigin(configService.getOrThrow<string>('app.webUrl'));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestContext>();
    const method = request.method.toUpperCase();

    if (!UNSAFE_METHODS.has(method) || this.nodeEnv !== 'production') {
      return true;
    }

    const origins = [readHeader(request.headers.origin), readReferer(request)]
      .filter((value): value is string => value !== undefined)
      .map(toOrigin);

    if (
      origins.length === 0 ||
      origins.some((origin) => origin !== this.webOrigin)
    ) {
      throw new ForbiddenException(CSRF_ERROR);
    }

    return true;
  }
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readReferer(request: RequestContext): string | undefined {
  const value = request.headers.referer ?? request.headers.referrer;
  return readHeader(value);
}

function toOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}
