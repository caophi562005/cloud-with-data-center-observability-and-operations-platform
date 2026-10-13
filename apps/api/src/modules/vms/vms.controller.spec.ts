import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import type { VmPage, VmRecord } from './vms.types.js';
import { VmsController } from './vms.controller.js';
import { VmsService } from './vms.service.js';

const ORG_A = '00000000-0000-4000-8000-000000000001';
const VM_A = '00000000-0000-4000-8000-000000000002';

const vm: VmRecord = {
  id: VM_A,
  organizationId: ORG_A,
  hostname: 'db-prod-01',
  ipAddress: null,
  os: null,
  status: 'DISCONNECTED',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  tags: [],
  agent: null,
};

const page: VmPage = {
  items: [vm],
  page: 1,
  pageSize: 50,
  total: 1,
};

describe('VmsController', () => {
  it('exposes the five organization-scoped VM inventory handlers', async () => {
    const service = {
      list: vi.fn().mockResolvedValue(page),
      create: vi.fn().mockResolvedValue({
        vm,
        enrollment: {
          tokenId: 'token-1',
          token: `ENR_${'a'.repeat(43)}`,
          expiresAt: new Date('2026-10-02T00:00:00.000Z'),
        },
      }),
      get: vi.fn().mockResolvedValue(vm),
      update: vi.fn().mockResolvedValue(vm),
      remove: vi.fn().mockResolvedValue(undefined),
      addTag: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000003',
        key: 'env',
        value: 'production',
      }),
      updateTag: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000004',
        key: 'env',
        value: 'staging',
      }),
      removeTag: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new VmsController(service as unknown as VmsService);
    const params = { organizationId: ORG_A, vmId: VM_A };

    await expect(
      controller.list(
        { organizationId: ORG_A },
        { page: 1, pageSize: 50, tag: [] },
      ),
    ).resolves.toEqual(page);
    await expect(
      controller.create({ organizationId: ORG_A }, { hostname: 'db-prod-01' }),
    ).resolves.toMatchObject({ vm });
    await expect(controller.get(params)).resolves.toEqual(vm);
    await expect(
      controller.update(params, { hostname: 'db-prod-02' }),
    ).resolves.toEqual(vm);
    await expect(controller.remove(params)).resolves.toBeUndefined();
    await expect(
      controller.addTag(params, { key: 'env', value: 'production' }),
    ).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000003',
      key: 'env',
      value: 'production',
    });
    await expect(
      controller.updateTag(
        { ...params, tagId: '00000000-0000-4000-8000-000000000003' },
        { key: 'env', value: 'staging' },
      ),
    ).resolves.toEqual({
      id: '00000000-0000-4000-8000-000000000004',
      key: 'env',
      value: 'staging',
    });
    await expect(
      controller.removeTag({
        ...params,
        tagId: '00000000-0000-4000-8000-000000000003',
      }),
    ).resolves.toBeUndefined();

    expect(service.list).toHaveBeenCalledWith(ORG_A, {
      page: 1,
      pageSize: 50,
      tags: [],
    });
    expect(service.create).toHaveBeenCalledWith(ORG_A, {
      hostname: 'db-prod-01',
    });
    expect(service.get).toHaveBeenCalledWith(ORG_A, VM_A);
    expect(service.update).toHaveBeenCalledWith(ORG_A, VM_A, {
      hostname: 'db-prod-02',
    });
    expect(service.remove).toHaveBeenCalledWith(ORG_A, VM_A);
    expect(service.addTag).toHaveBeenCalledWith(ORG_A, VM_A, {
      key: 'env',
      value: 'production',
    });
    expect(service.updateTag).toHaveBeenCalledWith(
      ORG_A,
      VM_A,
      '00000000-0000-4000-8000-000000000003',
      { key: 'env', value: 'staging' },
    );
    expect(service.removeTag).toHaveBeenCalledWith(
      ORG_A,
      VM_A,
      '00000000-0000-4000-8000-000000000003',
    );
  });

  it('declares tenant read/write permissions on VM handlers', () => {
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.list),
    ).toEqual(['vm.read']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.get),
    ).toEqual(['vm.read']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.create),
    ).toEqual(['vm.manage']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.update),
    ).toEqual(['vm.manage']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.remove),
    ).toEqual(['vm.manage']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.addTag),
    ).toEqual(['vm.manage']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.updateTag),
    ).toEqual(['vm.manage']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.removeTag),
    ).toEqual(['vm.manage']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        VmsController.prototype.reissueEnrollmentToken,
      ),
    ).toEqual(['vm.enroll']);
    expect(
      Reflect.getMetadata(PERMISSIONS_KEY, VmsController.prototype.revokeAgent),
    ).toEqual(['vm.agent.revoke']);
  });

  it('routes reissue and revoke without accepting a request body', async () => {
    const service = {
      reissueEnrollmentToken: vi.fn().mockResolvedValue({
        tokenId: 'token-2',
        token: `ENR_${'b'.repeat(43)}`,
        expiresAt: new Date('2026-10-02T00:00:00.000Z'),
      }),
      revokeAgent: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new VmsController(service as unknown as VmsService);
    const params = { organizationId: ORG_A, vmId: VM_A };

    await expect(controller.reissueEnrollmentToken(params)).resolves.toEqual({
      tokenId: 'token-2',
      token: `ENR_${'b'.repeat(43)}`,
      expiresAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    await expect(controller.revokeAgent(params)).resolves.toBeUndefined();

    expect(service.reissueEnrollmentToken).toHaveBeenCalledWith(ORG_A, VM_A);
    expect(service.revokeAgent).toHaveBeenCalledWith(ORG_A, VM_A);
  });

  it('applies Cognito authentication and organization permission guards at class level', () => {
    expect(Reflect.getMetadata('__guards__', VmsController)).toEqual([
      CognitoAuthGuard,
      PermissionsGuard,
    ]);
  });
});
