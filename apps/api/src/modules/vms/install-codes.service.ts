import { Injectable } from '@nestjs/common';
import { EnrollmentRepository } from './enrollment.repository.js';
import { SecretService } from './secret.service.js';
import type { OrganizationInstallCodeResponse } from './vms.types.js';

@Injectable()
export class InstallCodesService {
  constructor(
    private readonly enrollmentRepository: EnrollmentRepository,
    private readonly secretService: SecretService,
  ) {}

  async issue(
    organizationId: string,
  ): Promise<OrganizationInstallCodeResponse> {
    const secret = this.secretService.generate('ENR_');
    const issued = await this.enrollmentRepository.issueOrganizationToken(
      organizationId,
      secret.hash,
      new Date(),
    );
    // No plaintext cache or later read endpoint for organization codes.
    return { ...issued, token: secret.value, maxUses: 1 };
  }

  revoke(organizationId: string, tokenId: string): Promise<void> {
    return this.enrollmentRepository.revokeOrganizationToken(
      organizationId,
      tokenId,
    );
  }
}
