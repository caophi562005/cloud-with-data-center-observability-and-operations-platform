import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  type ArgumentMetadata,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator.js';
import { SkipCsrf } from '../../common/decorators/skip-csrf.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import {
  enrollmentSchema,
  enrollmentTransportSchema,
  type EnrollmentInput,
} from './schemas/enrollment.schema.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';

class EnrollmentValidationPipe extends ZodValidationPipe<EnrollmentInput> {
  constructor() {
    super(enrollmentSchema);
  }

  override transform(
    value: unknown,
    metadata?: ArgumentMetadata,
  ): EnrollmentInput {
    try {
      return super.transform(value, metadata);
    } catch (error) {
      const transportResult = enrollmentTransportSchema.safeParse(value);
      if (transportResult.success) {
        return transportResult.data;
      }
      throw error;
    }
  }
}

@Controller('agent-enrollment')
@Public()
export class AgentEnrollmentController {
  constructor(
    private readonly agentEnrollmentService: AgentEnrollmentService,
  ) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @SkipCsrf()
  @HttpCode(HttpStatus.CREATED)
  enroll(@Body(new EnrollmentValidationPipe()) input: EnrollmentInput) {
    return this.agentEnrollmentService.enroll(input);
  }
}
