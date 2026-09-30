import { ConflictException, NotFoundException } from '@nestjs/common';

export type ConflictCode =
  | 'USER_COGNITO_SUB_CONFLICT'
  | 'ORGANIZATION_SLUG_CONFLICT'
  | 'MEMBERSHIP_ALREADY_EXISTS';

export type NotFoundCode = 'ORGANIZATION_NOT_FOUND' | 'MEMBERSHIP_NOT_FOUND';

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
