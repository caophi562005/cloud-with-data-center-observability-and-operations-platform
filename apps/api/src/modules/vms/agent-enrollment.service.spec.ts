import { describe, expect, it, vi } from 'vitest';
import { ApplicationConflictError } from '../../common/errors/application-conflict.error.js';
import { EnrollmentRepository } from './enrollment.repository.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';
import { SecretService } from './secret.service.js';

const VALID_TOKEN = `ENR_${'a'.repeat(43)}`;
const TOKEN_HASH = 'token-hash-only';
const AGENT_CREDENTIAL = `AGT_${'b'.repeat(43)}`;
const CREDENTIAL_HASH = 'credential-hash-only';
const ORG_A = '00000000-0000-4000-8000-000000000001';
const VM_A = '00000000-0000-4000-8000-000000000002';
const AGENT_A = '00000000-0000-4000-8000-000000000003';

function createService(
  repositoryResult: unknown = {
    agentId: AGENT_A,
    organizationId: ORG_A,
    vmId: VM_A,
  },
) {
  const repository = {
    consumeAndEnroll: vi.fn().mockResolvedValue(repositoryResult),
  };
  const secretService = {
    generate: vi.fn().mockReturnValue({
      value: AGENT_CREDENTIAL,
      hash: CREDENTIAL_HASH,
    }),
    hash: vi.fn().mockReturnValue(TOKEN_HASH),
  };

  return {
    service: new AgentEnrollmentService(
      repository as unknown as EnrollmentRepository,
      secretService as unknown as SecretService,
    ),
    repository,
    secretService,
  };
}

describe('AgentEnrollmentService', () => {
  it('hashes the token and returns only the newly generated credential on success', async () => {
    const { service, repository, secretService } = createService();

    await expect(
      service.enroll({ token: VALID_TOKEN, os: 'Ubuntu 24.04' }),
    ).resolves.toEqual({
      agentId: AGENT_A,
      organizationId: ORG_A,
      vmId: VM_A,
      credential: AGENT_CREDENTIAL,
      status: 'ACTIVE',
    });

    expect(secretService.hash).toHaveBeenCalledWith(VALID_TOKEN);
    expect(secretService.generate).toHaveBeenCalledWith('AGT_');
    expect(repository.consumeAndEnroll).toHaveBeenCalledWith({
      tokenHash: TOKEN_HASH,
      credentialHash: CREDENTIAL_HASH,
      os: 'Ubuntu 24.04',
      now: expect.any(Date),
    });
    const repositoryInput = JSON.stringify(
      repository.consumeAndEnroll.mock.calls[0][0],
    );
    expect(repositoryInput).not.toContain(VALID_TOKEN);
    expect(repositoryInput).not.toContain(AGENT_CREDENTIAL);
  });

  it('does not send an OS update when OS metadata is absent', async () => {
    const { service, repository } = createService();

    await expect(service.enroll({ token: VALID_TOKEN })).resolves.toMatchObject(
      {
        agentId: AGENT_A,
        status: 'ACTIVE',
      },
    );

    expect(repository.consumeAndEnroll.mock.calls[0][0]).not.toHaveProperty(
      'os',
    );
  });

  it.each(['invalid', 'expired', 'consumed', 'revoked'])(
    'maps a %s token result to the same generic 401 error',
    async () => {
      const { service } = createService(null);

      await expect(
        service.enroll({ token: VALID_TOKEN }),
      ).rejects.toMatchObject({
        code: 'ENROLLMENT_TOKEN_INVALID',
        message: 'Enrollment token is invalid or expired',
      });
      await expect(
        service.enroll({ token: VALID_TOKEN }),
      ).rejects.toMatchObject({
        code: 'ENROLLMENT_TOKEN_INVALID',
        message: 'Enrollment token is invalid or expired',
      });
    },
  );

  it('propagates an active-agent conflict without consuming or translating it', async () => {
    const conflict = new ApplicationConflictError(
      'AGENT_ALREADY_ENROLLED',
      'Agent is already enrolled',
    );
    const { service, repository } = createService();
    repository.consumeAndEnroll.mockRejectedValue(conflict);

    await expect(service.enroll({ token: VALID_TOKEN })).rejects.toBe(conflict);
  });

  it('hashes the enrollment token before generating a credential', async () => {
    const { service, secretService } = createService();

    await service.enroll({ token: VALID_TOKEN });

    expect(secretService.hash.mock.invocationCallOrder[0]).toBeLessThan(
      secretService.generate.mock.invocationCallOrder[0],
    );
  });
});
