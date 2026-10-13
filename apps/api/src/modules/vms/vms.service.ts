import { Injectable, Optional } from '@nestjs/common';
import { getVmMetricsCapabilities, resolveVmMetricPlatform } from './vm-metrics-capabilities.js';
import { VmMetricsService } from './vm-metrics.service.js';
import {
  ApplicationConflictError,
  ApplicationNotFoundError,
  hasPrismaErrorCode,
} from '../../common/errors/application-conflict.error.js';
import {
  EnrollmentRepository,
  type EnrollmentTokenReuse,
} from './enrollment.repository.js';
import { EnrollmentTokenCacheService } from './enrollment-token-cache.service.js';
import { SecretService } from './secret.service.js';
import {
  DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS,
  type EnrollmentTokenPublic,
  type TokenSeed,
  type VmCreateResponse,
  type VmListFilters,
  type VmPage,
  type VmRecord,
  type VmTagRecord,
} from './vms.types.js';
import { VmsRepository } from './vms.repository.js';
import type {
  VmCreateInput,
  VmTagInput,
  VmUpdateInput,
} from './schemas/vm.schema.js';

@Injectable()
export class VmsService {
  constructor(
    private readonly vmsRepository: VmsRepository,
    private readonly secretService: SecretService,
    private readonly enrollmentRepository?: EnrollmentRepository,
    private readonly enrollmentTokenCache?: EnrollmentTokenCacheService,
    @Optional() private readonly telemetry?: VmMetricsService,
  ) {}

  async create(
    organizationId: string,
    input: VmCreateInput,
  ): Promise<VmCreateResponse> {
    const generated = this.secretService.generate('ENR_');
    const seed: TokenSeed = {
      hash: generated.hash,
      expiresAt: new Date(
        Date.now() + DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS * 1000,
      ),
    };

    try {
      const result = await this.vmsRepository.createWithEnrollment(
        organizationId,
        input,
        seed,
      );
      const enrollment = {
        tokenId: result.tokenId,
        token: generated.value,
        expiresAt: result.expiresAt,
      };
      await this.enrollmentTokenCache?.set(
        organizationId,
        result.vm.id,
        enrollment,
      );
      return { vm: result.vm, enrollment };
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new ApplicationConflictError(
          'VM_HOSTNAME_CONFLICT',
          'VM hostname is already in use',
        );
      }
      throw error;
    }
  }

  async reissueEnrollmentToken(
    organizationId: string,
    vmId: string,
    now?: Date,
  ): Promise<EnrollmentTokenPublic> {
    const generated = this.secretService.generate('ENR_');
    const issuedAt = now ?? new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + DEFAULT_ENROLLMENT_TOKEN_TTL_SECONDS * 1000,
    );

    try {
      const enrollmentRepository = this.getEnrollmentRepository();
      const recovered: { token: EnrollmentTokenPublic | null } = {
        token: null,
      };
      const cache = this.enrollmentTokenCache;
      const reuse: EnrollmentTokenReuse | undefined = cache
        ? {
            read: async (current) => {
              const cached = await cache.get(
                organizationId,
                vmId,
                current.tokenId,
              );
              recovered.token = cached;
              return cached
                ? {
                    tokenId: cached.tokenId,
                    hash: this.secretService.hash(cached.token),
                    expiresAt: cached.expiresAt,
                  }
                : null;
            },
            write: async (issued) => {
              await cache.set(organizationId, vmId, {
                ...issued,
                token: generated.value,
              });
            },
          }
        : undefined;
      const issued = reuse
        ? await enrollmentRepository.issueToken(
            organizationId,
            vmId,
            { hash: generated.hash, expiresAt },
            issuedAt,
            reuse,
          )
        : now
          ? await enrollmentRepository.issueToken(
              organizationId,
              vmId,
              { hash: generated.hash, expiresAt },
              issuedAt,
            )
          : await enrollmentRepository.issueToken(organizationId, vmId, {
              hash: generated.hash,
              expiresAt,
            });
      const token =
        recovered.token?.tokenId === issued.tokenId
          ? recovered.token.token
          : generated.value;
      return {
        tokenId: issued.tokenId,
        token,
        expiresAt: issued.expiresAt,
      };
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound();
      }
      throw error;
    }
  }

  async revokeAgent(
    organizationId: string,
    vmId: string,
    now?: Date,
  ): Promise<void> {
    try {
      await this.getEnrollmentRepository().revokeAgent(
        organizationId,
        vmId,
        now ?? new Date(),
      );
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound('Agent not found');
      }
      throw error;
    }
  }

  async list(organizationId: string, filters: VmListFilters): Promise<VmPage> {
    const page = await this.vmsRepository.list(organizationId, filters);
    if (!this.telemetry) return { ...page, items: page.items.map(withCapabilities) };
    return {
      ...page,
      items: await this.telemetry.enrichPage(organizationId, page.items),
    };
  }

  async get(organizationId: string, vmId: string): Promise<VmRecord> {
    const vm = await this.vmsRepository.getById(organizationId, vmId);
    if (!vm) {
      throw resourceNotFound();
    }
    return this.telemetry
      ? (await this.telemetry.enrichPage(organizationId, [vm]))[0]
      : withCapabilities(vm);
  }

  async update(
    organizationId: string,
    vmId: string,
    input: VmUpdateInput,
  ): Promise<VmRecord> {
    try {
      return await this.vmsRepository.update(organizationId, vmId, input);
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2002')) {
        throw new ApplicationConflictError(
          'VM_HOSTNAME_CONFLICT',
          'VM hostname is already in use',
        );
      }
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound();
      }
      throw error;
    }
  }

  async remove(organizationId: string, vmId: string): Promise<void> {
    try {
      await this.vmsRepository.remove(organizationId, vmId);
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound();
      }
      throw error;
    }
  }

  async addTag(
    organizationId: string,
    vmId: string,
    input: VmTagInput,
  ): Promise<VmTagRecord> {
    try {
      return await this.vmsRepository.addTag(organizationId, vmId, input);
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound('VM tag not found');
      }
      throw error;
    }
  }

  async updateTag(
    organizationId: string,
    vmId: string,
    tagId: string,
    input: VmTagInput,
  ): Promise<VmTagRecord> {
    try {
      return await this.vmsRepository.updateTag(
        organizationId,
        vmId,
        tagId,
        input,
      );
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound('VM tag not found');
      }
      throw error;
    }
  }

  async removeTag(
    organizationId: string,
    vmId: string,
    tagId: string,
  ): Promise<void> {
    try {
      await this.vmsRepository.removeTag(organizationId, vmId, tagId);
    } catch (error) {
      if (hasPrismaErrorCode(error, 'P2025')) {
        throw resourceNotFound('VM tag not found');
      }
      throw error;
    }
  }
  private getEnrollmentRepository(): EnrollmentRepository {
    if (!this.enrollmentRepository) {
      throw new Error('EnrollmentRepository is not configured');
    }
    return this.enrollmentRepository;
  }
}

function withCapabilities(vm: VmRecord) {
  return { ...vm, metricsCapabilities: getVmMetricsCapabilities(resolveVmMetricPlatform(vm.os)) };
}

function resourceNotFound(message = 'VM not found'): ApplicationNotFoundError {
  return new ApplicationNotFoundError('RESOURCE_NOT_FOUND', message);
}
