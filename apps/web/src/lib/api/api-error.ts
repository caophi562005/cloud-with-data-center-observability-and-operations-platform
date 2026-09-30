const DEFAULT_STATUS_CODE = 500;

export const GENERIC_API_ERROR_CODE = "CLIENT_ERROR";
export const GENERIC_API_ERROR_MESSAGE =
  "Something went wrong. Please try again.";

export interface ApiErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  requestId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;

  const text = value.trim();
  if (!text || text.length > maxLength) return undefined;

  return text;
}

function isValidStatusCode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === 0 || (value >= 100 && value <= 599))
  );
}

function safeStatusCode(value: unknown, fallback = DEFAULT_STATUS_CODE): number {
  if (isValidStatusCode(value)) return value;
  return isValidStatusCode(fallback) ? fallback : DEFAULT_STATUS_CODE;
}

/**
 * Extract only the documented error fields from an API response body.
 * Unknown response shapes intentionally become a generic client error so raw
 * response bodies can never become user-facing error messages.
 */
export function parseApiErrorPayload(
  payload: unknown,
  statusCode?: number,
): ApiErrorPayload {
  if (!isRecord(payload)) {
    return {
      statusCode: safeStatusCode(statusCode),
      code: GENERIC_API_ERROR_CODE,
      message: GENERIC_API_ERROR_MESSAGE,
    };
  }

  const code = safeText(payload.code, 100);
  const message = safeText(payload.message, 500);

  if (!code || !message) {
    return {
      statusCode: safeStatusCode(statusCode, safeStatusCode(payload.statusCode)),
      code: GENERIC_API_ERROR_CODE,
      message: GENERIC_API_ERROR_MESSAGE,
    };
  }

  const requestId = safeText(payload.requestId, 200);

  return {
    statusCode: safeStatusCode(statusCode, safeStatusCode(payload.statusCode)),
    code,
    message,
    ...(requestId ? { requestId } : {}),
  };
}

function normalizeApiErrorPayload(payload: ApiErrorPayload): ApiErrorPayload {
  const requestId = safeText(payload.requestId, 200);

  return {
    statusCode: safeStatusCode(payload.statusCode),
    code: safeText(payload.code, 100) ?? GENERIC_API_ERROR_CODE,
    message: safeText(payload.message, 500) ?? GENERIC_API_ERROR_MESSAGE,
    ...(requestId ? { requestId } : {}),
  };
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(payload: ApiErrorPayload);
  constructor(
    statusCode: number,
    code: string,
    message: string,
    requestId?: string,
  );
  constructor(
    payloadOrStatusCode: ApiErrorPayload | number,
    code?: string,
    message?: string,
    requestId?: string,
  ) {
    const payload = normalizeApiErrorPayload(
      typeof payloadOrStatusCode === "number"
        ? {
            statusCode: payloadOrStatusCode,
            code: code ?? GENERIC_API_ERROR_CODE,
            message: message ?? GENERIC_API_ERROR_MESSAGE,
            ...(requestId ? { requestId } : {}),
          }
        : payloadOrStatusCode,
    );

    super(payload.message);
    this.name = "ApiError";
    this.statusCode = payload.statusCode;
    this.code = payload.code;
    this.requestId = payload.requestId;
  }

  static fromResponse(response: Response, payload: unknown): ApiError {
    return new ApiError(parseApiErrorPayload(payload, response.status));
  }

  static generic(statusCode = 0): ApiError {
    return new ApiError({
      statusCode,
      code: GENERIC_API_ERROR_CODE,
      message: GENERIC_API_ERROR_MESSAGE,
    });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}
