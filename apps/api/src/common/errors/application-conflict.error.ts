import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

export type ConflictCode =
  | 'USER_COGNITO_SUB_CONFLICT'
  | 'ORGANIZATION_SLUG_CONFLICT'
  | 'MEMBERSHIP_ALREADY_EXISTS'
  | 'VM_HOSTNAME_CONFLICT'
  | 'AGENT_ALREADY_ENROLLED';

export type NotFoundCode =
  'ORGANIZATION_NOT_FOUND' | 'MEMBERSHIP_NOT_FOUND' | 'RESOURCE_NOT_FOUND';

export type UnauthorizedCode = 'ENROLLMENT_TOKEN_INVALID';

export class ApplicationConflictError extends ConflictException {
  constructor(
    public readonly code: ConflictCode,
    message: string,
  ) {
    super({ code, message });
  }
}

export class ApplicationNotFoundError extends NotFoundException {
  constructor(
    public readonly code: NotFoundCode,
    message: string,
  ) {
    super({ code, message });
  }
}

export class ApplicationUnauthorizedError extends UnauthorizedException {
  constructor(
    public readonly code: UnauthorizedCode,
    message: string,
  ) {
    super({ code, message });
  }
}

export function hasPrismaErrorCode(
  error: unknown,
  code: string,
): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
