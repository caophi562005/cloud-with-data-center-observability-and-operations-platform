import {
  ConflictException,
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationUnauthorizedError } from '../errors/application-conflict.error.js';
import { HttpExceptionFilter } from './http-exception.filter.js';

function createHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const request = {
    id: 'request-123',
    requestId: 'request-123',
    headers: { 'x-request-id': 'request-123' },
  };
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => request,
      }),
    } as never,
    status,
    json,
  };
}

describe('HttpExceptionFilter', () => {
  it('preserves a recoverable refresh 503 without leaking provider details', () => {
    const context = createHost();
    new HttpExceptionFilter().catch(
      new ServiceUnavailableException({
        code: 'AUTH_REFRESH_UNAVAILABLE',
        message: 'AWS upstream synthetic-secret',
        details: { token: 'synthetic-secret' },
      }),
      context.host,
    );
    expect(context.status).toHaveBeenCalledWith(503);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 503,
      code: 'AUTH_REFRESH_UNAVAILABLE',
      message: 'We could not renew your session. Please try again.',
    });
  });
  it.each([
    ['METRICS_DISABLED', 'Metrics are not configured'],
    ['METRICS_UNAVAILABLE', 'Metrics are temporarily unavailable'],
  ])('sanitizes metrics failure %s', (code, message) => {
    const context = createHost();
    new HttpExceptionFilter().catch(
      new ServiceUnavailableException({
        code,
        message: 'provider synthetic-secret',
        details: 'url token',
        stack: 'secret',
      }),
      context.host,
    );
    expect(context.status).toHaveBeenCalledWith(503);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 503,
      code,
      message,
    });
  });
  it('maps known HTTP failures to stable application errors', () => {
    const cases = [
      [
        new HttpException('invalid body', 400),
        400,
        'VALIDATION_ERROR',
        'Validation failed',
      ],
      [
        new UnauthorizedException(),
        401,
        'AUTH_UNAUTHORIZED',
        'Authentication required',
      ],
      [
        new ForbiddenException(),
        403,
        'AUTH_FORBIDDEN',
        'Insufficient permissions',
      ],
      [new ConflictException(), 409, 'CONFLICT', 'Conflict'],
      [
        new HttpException('too many requests', 429),
        429,
        'RATE_LIMITED',
        'Too many requests',
      ],
    ] as const;

    for (const [exception, statusCode, code, message] of cases) {
      const context = createHost();
      new HttpExceptionFilter().catch(exception, context.host);

      expect(context.status).toHaveBeenCalledWith(statusCode);
      expect(context.json).toHaveBeenCalledWith({
        statusCode,
        code,
        message,
      });
    }
  });

  it('preserves safe application error codes while removing exception internals', () => {
    const context = createHost();
    const exception = new UnauthorizedException({
      statusCode: 401,
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid credentials',
      awsRequestId: 'aws-secret-request-id',
      stack: 'sensitive-stack',
      token: 'sensitive-token',
    });

    new HttpExceptionFilter().catch(exception, context.host);

    expect(context.json).toHaveBeenCalledWith({
      statusCode: 401,
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid credentials',
    });
    const serialized = JSON.stringify(context.json.mock.calls[0][0]);
    expect(serialized).not.toContain('aws-secret-request-id');
    expect(serialized).not.toContain('sensitive-stack');
    expect(serialized).not.toContain('sensitive-token');
    expect(serialized).not.toContain('request-123');
  });

  it('sanitizes validation issue messages and keeps request IDs out of JSON', () => {
    const context = createHost();
    const exception = new HttpException(
      {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          issues: [
            {
              path: ['password'],
              code: 'custom',
              message: 'password=super-secret-token',
            },
          ],
        },
      },
      400,
    );

    new HttpExceptionFilter().catch(exception, context.host);

    const body = context.json.mock.calls[0][0];
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: {
        issues: [
          { path: ['password'], code: 'custom', message: 'Invalid value' },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain('super-secret-token');
    expect(JSON.stringify(body)).not.toContain('request-123');
  });

  it('normalizes invalid HTTP status codes to a safe internal error', () => {
    const context = createHost();
    new HttpExceptionFilter().catch(
      new HttpException('invalid status', 400.5),
      context.host,
    );

    expect(context.status).toHaveBeenCalledWith(500);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  it('maps unknown errors to a generic response without leaking the exception', () => {
    const context = createHost();
    new HttpExceptionFilter().catch(
      new Error('AWS request id aws-secret and password=super-secret'),
      context.host,
    );

    expect(context.status).toHaveBeenCalledWith(500);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    const serialized = JSON.stringify(context.json.mock.calls[0][0]);
    expect(serialized).not.toContain('aws-secret');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('request-123');
  });

  it('preserves sanitized health status metadata for unavailable dependencies', () => {
    const context = createHost();
    const exception = new ServiceUnavailableException({
      status: 'error',
      info: {},
      error: {
        database: { status: 'down', message: 'DATABASE_URL=secret-value' },
      },
      details: {
        database: { status: 'down', message: 'DATABASE_URL=secret-value' },
      },
    });

    new HttpExceptionFilter().catch(exception, context.host);

    expect(context.status).toHaveBeenCalledWith(503);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 503,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      details: {
        health: {
          status: 'error',
          info: {},
          error: { database: { status: 'down' } },
          details: { database: { status: 'down' } },
        },
      },
    });
    expect(JSON.stringify(context.json.mock.calls[0][0])).not.toContain(
      'secret-value',
    );
  });

  it('enforces enrollment token failures as typed 401 errors', () => {
    const context = createHost();
    const exception = new ApplicationUnauthorizedError(
      'ENROLLMENT_TOKEN_INVALID',
      'token=secret-value',
    );

    expect(exception).toBeInstanceOf(UnauthorizedException);
    expect(exception.getStatus()).toBe(401);
    expect(exception.code).toBe('ENROLLMENT_TOKEN_INVALID');

    new HttpExceptionFilter().catch(exception, context.host);

    expect(context.status).toHaveBeenCalledWith(401);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 401,
      code: 'ENROLLMENT_TOKEN_INVALID',
      message: 'Enrollment token is invalid or expired',
    });
    expect(JSON.stringify(context.json.mock.calls[0][0])).not.toContain(
      'secret-value',
    );
  });

  it('forces generic enrollment token errors to safe 401 responses', () => {
    const context = createHost();
    const exception = new HttpException(
      { code: 'ENROLLMENT_TOKEN_INVALID', message: 'token=secret-value' },
      409,
    );

    new HttpExceptionFilter().catch(exception, context.host);

    expect(context.status).toHaveBeenCalledWith(401);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 401,
      code: 'ENROLLMENT_TOKEN_INVALID',
      message: 'Enrollment token is invalid or expired',
    });
    expect(JSON.stringify(context.json.mock.calls[0][0])).not.toContain(
      'secret-value',
    );
  });

  it('enforces resource-not-found errors as 404 responses', () => {
    const context = createHost();
    const exception = new HttpException(
      { code: 'RESOURCE_NOT_FOUND', message: 'internal lookup details' },
      409,
    );

    new HttpExceptionFilter().catch(exception, context.host);

    expect(context.status).toHaveBeenCalledWith(404);
    expect(context.json).toHaveBeenCalledWith({
      statusCode: 404,
      code: 'RESOURCE_NOT_FOUND',
      message: 'Resource not found',
    });
  });
});
