import { Injectable } from '@nestjs/common';
import { ApplicationUnauthorizedError } from '../../common/errors/application-conflict.error.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import { EnrollmentTokenCacheService } from './enrollment-token-cache.service.js';
import type { EnrollmentInput } from './schemas/enrollment.schema.js';
import { SecretService } from './secret.service.js';
import type { AgentEnrollmentResponse } from './vms.types.js';

@Injectable()
export class AgentEnrollmentService {
  constructor(
    private readonly enrollmentRepository: EnrollmentRepository,
    private readonly secretService: SecretService,
    private readonly enrollmentTokenCache?: EnrollmentTokenCacheService,
  ) {}

  async enroll(input: EnrollmentInput): Promise<AgentEnrollmentResponse> {
    if (!/^ENR_[A-Za-z0-9_-]{43}$/.test(input.token)) {
      throw new ApplicationUnauthorizedError(
        'ENROLLMENT_TOKEN_INVALID',
        'Enrollment token is invalid or expired',
      );
    }
    const tokenHash = this.secretService.hash(input.token);
    const generatedCredential = this.secretService.generate('AGT_');
    const result = await this.enrollmentRepository.consumeAndEnroll({
      tokenHash,
      credentialHash: generatedCredential.hash,
      ...(input.os === undefined ? {} : { os: input.os }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.collectorType === undefined
        ? {}
        : { collectorType: input.collectorType }),
      ...(input.collectorVersion === undefined
        ? {}
        : { collectorVersion: input.collectorVersion }),
      ...(input.buildId === undefined ? {} : { buildId: input.buildId }),
      now: new Date(),
    });

    if (!result) {
      throw new ApplicationUnauthorizedError(
        'ENROLLMENT_TOKEN_INVALID',
        'Enrollment token is invalid or expired',
      );
    }

    await this.enrollmentTokenCache?.invalidate(
      result.organizationId,
      result.vmId,
    );

    return {
      agentId: result.agentId,
      organizationId: result.organizationId,
      vmId: result.vmId,
      credential: generatedCredential.value,
      status: 'ACTIVE',
      desiredVersion: result.desiredVersion,
    };
  }
}
