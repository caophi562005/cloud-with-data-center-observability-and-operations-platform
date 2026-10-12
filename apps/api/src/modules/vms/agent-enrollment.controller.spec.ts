import { HttpStatus, RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { SKIP_CSRF_KEY } from '../../common/decorators/skip-csrf.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AgentEnrollmentController } from './agent-enrollment.controller.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';

const VALID_TOKEN = `ENR_${'a'.repeat(43)}`;
const ORG_A = '00000000-0000-4000-8000-000000000001';
const VM_A = '00000000-0000-4000-8000-000000000002';
const AGENT_A = '00000000-0000-4000-8000-000000000003';

function bodyPipeMetadata() {
  const routeArgs = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    AgentEnrollmentController,
    'enroll',
  ) as Record<string, { pipes?: unknown[] }>;
  return Object.values(routeArgs).find((metadata) =>
    metadata.pipes?.some((pipe) => pipe instanceof ZodValidationPipe),
  );
}

describe('AgentEnrollmentController', () => {
  it('is public, exposes POST /agent-enrollment with HTTP 201, and delegates the body', async () => {
    const service = {
      enroll: vi.fn().mockResolvedValue({
        agentId: AGENT_A,
        organizationId: ORG_A,
        vmId: VM_A,
        credential: `AGT_${'b'.repeat(43)}`,
        status: 'ACTIVE',
      }),
    };
    const controller = new AgentEnrollmentController(
      service as unknown as AgentEnrollmentService,
    );

    await expect(controller.enroll({ token: VALID_TOKEN })).resolves.toEqual({
      agentId: AGENT_A,
      organizationId: ORG_A,
      vmId: VM_A,
      credential: `AGT_${'b'.repeat(43)}`,
      status: 'ACTIVE',
    });
    expect(service.enroll).toHaveBeenCalledWith({ token: VALID_TOKEN });

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AgentEnrollmentController)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(
        SKIP_CSRF_KEY,
        AgentEnrollmentController.prototype.enroll,
      ),
    ).toBe(true);
    expect(Reflect.getMetadata(PATH_METADATA, AgentEnrollmentController)).toBe(
      'agent-enrollment',
    );
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        AgentEnrollmentController.prototype.enroll,
      ),
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        AgentEnrollmentController.prototype.enroll,
      ),
    ).toBe('/');
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        AgentEnrollmentController.prototype.enroll,
      ),
    ).toBe(HttpStatus.CREATED);
  });

  it('uses a strict enrollment Zod pipe that rejects request tenant fields', () => {
    const metadata = bodyPipeMetadata();
    expect(metadata).toBeDefined();

    const pipe = metadata?.pipes?.find(
      (candidate) => candidate instanceof ZodValidationPipe,
    ) as ZodValidationPipe;
    expect(() =>
      pipe.transform({
        token: VALID_TOKEN,
        organizationId: ORG_A,
        vmId: VM_A,
      }),
    ).toThrow();
  });

  it('passes bounded malformed tokens to the generic unauthorized service path', () => {
    const metadata = bodyPipeMetadata();
    const pipe = metadata?.pipes?.find(
      (candidate) => candidate instanceof ZodValidationPipe,
    ) as ZodValidationPipe;

    expect(pipe.transform({ token: 'not-a-token' })).toEqual({
      token: 'not-a-token',
    });
    expect(() =>
      pipe.transform({ token: 'not-a-token', organizationId: ORG_A }),
    ).toThrow();
  });
});
