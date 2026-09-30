import {
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  ApiError,
  ApiHealthCheckDetails,
  ApiHealthStatus,
  ApiValidationIssue,
} from '../types/api-error.type.js';
import type { RequestContext } from '../types/request-context.type.js';

type ExceptionPayload = {
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
  issues?: unknown;
};

const SAFE_CODES = new Set([
  'VALIDATION_ERROR',
  'AUTH_INVALID_CREDENTIALS',
  'AUTH_UNAUTHORIZED',
  'AUTH_FORBIDDEN',
  'AUTH_REGISTRATION_PENDING',
  'AUTH_CONFIRMATION_INVALID',
  'AUTH_REGISTRATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
]);

const DEFAULT_ERRORS: Record<string, Pick<ApiError, 'code' | 'message'>> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: 'AUTH_UNAUTHORIZED',
    message: 'Authentication required',
  },
  [HttpStatus.FORBIDDEN]: {
    code: 'AUTH_FORBIDDEN',
    message: 'Insufficient permissions',
  },
  [HttpStatus.NOT_FOUND]: {
    code: 'NOT_FOUND',
    message: 'Resource not found',
  },
  [HttpStatus.CONFLICT]: {
    code: 'CONFLICT',
    message: 'Conflict',
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: 'RATE_LIMITED',
    message: 'Too many requests',
  },
};

const SAFE_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Validation failed',
  AUTH_INVALID_CREDENTIALS: 'Invalid credentials',
  AUTH_UNAUTHORIZED: 'Authentication required',
  AUTH_FORBIDDEN: 'Insufficient permissions',
  AUTH_REGISTRATION_PENDING:
    'Registration may already be pending. Request a new confirmation code.',
  AUTH_CONFIRMATION_INVALID: 'Confirmation code is invalid or expired',
  AUTH_REGISTRATION_FAILED: 'Registration could not be completed',
  CONFLICT: 'Conflict',
  RATE_LIMITED: 'Too many requests',
  NOT_FOUND: 'Resource not found',
  INTERNAL_ERROR: 'Internal server error',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function payloadOf(exception: unknown): ExceptionPayload {
  if (exception instanceof HttpException) {
    const response = exception.getResponse();
    return isRecord(response) ? response : { message: response };
  }

  return isRecord(exception) ? exception : {};
}

function isValidStatusCode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 599
  );
}

function statusOf(exception: unknown, payload: ExceptionPayload): number {
  let statusCode: unknown;
  try {
    statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : payload.statusCode;
  } catch {
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  return isValidStatusCode(statusCode)
    ? statusCode
    : HttpStatus.INTERNAL_SERVER_ERROR;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODES.has(value) ? value : undefined;
}

function safeValidationIssues(
  payload: ExceptionPayload,
): ApiValidationIssue[] | undefined {
  const details = isRecord(payload.details) ? payload.details : undefined;
  const rawIssues = details?.issues ?? payload.issues;

  if (!Array.isArray(rawIssues)) {
    return undefined;
  }

  const issues = rawIssues.flatMap((issue): ApiValidationIssue[] => {
    if (!isRecord(issue)) {
      return [];
    }

    const path = Array.isArray(issue.path)
      ? issue.path
          .filter(
            (part): part is string | number =>
              typeof part === 'string' || typeof part === 'number',
          )
          .map(String)
      : [];
    const code = typeof issue.code === 'string' ? issue.code : 'invalid';
    return [{ path, code, message: 'Invalid value' }];
  });

  return issues;
}

function safeHealthCheckDetails(
  value: unknown,
): Record<string, { status: ApiHealthStatus }> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, detail]) => {
      if (!isRecord(detail) || !isHealthStatus(detail.status)) {
        return [];
      }
      return [[key, { status: detail.status }]];
    }),
  );
}

function safeHealthCheck(
  payload: ExceptionPayload,
): ApiHealthCheckDetails | undefined {
  const candidate: Record<string, unknown> = isRecord(payload.message)
    ? payload.message
    : (payload as Record<string, unknown>);
  if (!isRecord(candidate) || !isHealthCheckStatus(candidate.status)) {
    return undefined;
  }

  if (!isRecord(candidate.details)) {
    return undefined;
  }

  return {
    status: candidate.status,
    info: safeHealthCheckDetails(candidate.info),
    error: safeHealthCheckDetails(candidate.error),
    details: safeHealthCheckDetails(candidate.details),
  };
}

function isHealthStatus(value: unknown): value is ApiHealthStatus {
  return value === 'up' || value === 'down' || value === 'degraded';
}

function isHealthCheckStatus(
  value: unknown,
): value is ApiHealthCheckDetails['status'] {
  return (
    value === 'ok' ||
    value === 'error' ||
    value === 'degraded' ||
    value === 'shutting_down'
  );
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<RequestContext>();
    const payload = payloadOf(exception);
    const statusCode = statusOf(exception, payload);
    const defaults = DEFAULT_ERRORS[String(statusCode)] ??
      DEFAULT_ERRORS[String(HttpStatus.INTERNAL_SERVER_ERROR)] ?? {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      };
    const code = safeCode(payload.code) ?? defaults.code;
    const apiError: ApiError = {
      statusCode,
      code,
      message: SAFE_MESSAGES[code] ?? defaults.message,
    };

    if (code === 'VALIDATION_ERROR') {
      const issues = safeValidationIssues(payload);
      if (issues) {
        apiError.details = { issues };
      }
    }

    if (statusCode === HttpStatus.SERVICE_UNAVAILABLE) {
      const health = safeHealthCheck(payload);
      if (health) {
        apiError.details = { health };
      }
    }

    const requestId = this.requestId(request);
    if (statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        { requestId: requestId ?? 'unknown', code },
        'Unhandled HTTP exception',
      );
    }

    response.status(statusCode).json(apiError);
  }

  private requestId(request: RequestContext): string | undefined {
    if (typeof request.requestId === 'string' && request.requestId.length > 0) {
      return request.requestId;
    }

    if (typeof request.id === 'string' && request.id.length > 0) {
      return request.id;
    }

    const header = request.headers['x-request-id'];
    if (Array.isArray(header)) {
      return header[0];
    }

    return typeof header === 'string' && header.length > 0 ? header : undefined;
  }
}
