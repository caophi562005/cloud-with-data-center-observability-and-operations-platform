import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/database/prisma/prisma.service.js';
import { SecretService } from './secret.service.js';
import type { AgentIdentity } from './monitoring/monitoring.types.js';

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secretService: SecretService,
  ) {}

  async authenticate(
    authorization: string | undefined,
  ): Promise<AgentIdentity> {
    const match =
      typeof authorization === 'string'
        ? /^Bearer (AGT_[A-Za-z0-9_-]{43})$/.exec(authorization)
        : null;
    // JS '$' may match before a final newline; require an exact full-header match.
    if (!match || match[0] !== authorization) throw new UnauthorizedException();

    // Hash the entire credential, including its AGT_ prefix. Every request reads
    // DB authority; no positive-auth cache and no browser cookie fallback.
    const agent = await this.prisma.agent.findUnique({
      where: { credentialHash: this.secretService.hash(match[1]!) },
      select: {
        id: true,
        status: true,
        organizationId: true,
        vmId: true,
        vm: {
          select: {
            id: true,
            organizationId: true,
            organization: { select: { id: true } },
          },
        },
      },
    });
    if (
      !agent ||
      agent.status !== AgentStatus.ACTIVE ||
      agent.vmId !== agent.vm.id ||
      agent.organizationId !== agent.vm.organizationId ||
      agent.organizationId !== agent.vm.organization.id
    ) {
      throw new UnauthorizedException();
    }
    return {
      organizationId: agent.vm.organization.id,
      vmId: agent.vm.id,
      agentId: agent.id,
    };
  }
}
