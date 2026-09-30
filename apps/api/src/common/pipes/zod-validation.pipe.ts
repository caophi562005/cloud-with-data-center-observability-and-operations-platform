import {
  BadRequestException,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import { z } from 'zod';
import type { ApiValidationIssue } from '../types/api-error.type.js';

export class ZodValidationPipe<TOutput = unknown> implements PipeTransform<
  unknown,
  TOutput
> {
  constructor(private readonly schema: z.ZodType<TOutput>) {}

  transform(value: unknown, _metadata?: ArgumentMetadata): TOutput {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (!(error instanceof z.ZodError)) {
        throw error;
      }

      const issues: ApiValidationIssue[] = error.issues.map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
        message: 'Invalid value',
      }));

      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: { issues },
      });
    }
  }
}
