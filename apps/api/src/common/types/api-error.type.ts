export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_UNAUTHORIZED'
  | 'AUTH_FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | (string & {});

export type ApiValidationIssue = {
  path: string[];
  code: string;
  message: string;
};

export type ApiHealthStatus = 'up' | 'down' | 'degraded';

export type ApiHealthCheckDetails = {
  status: 'ok' | 'error' | 'degraded' | 'shutting_down';
  info: Record<string, { status: ApiHealthStatus }>;
  error: Record<string, { status: ApiHealthStatus }>;
  details: Record<string, { status: ApiHealthStatus }>;
};

export type ApiErrorDetails = {
  issues?: ApiValidationIssue[];
  health?: ApiHealthCheckDetails;
};

export type ApiError = {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetails;
};
