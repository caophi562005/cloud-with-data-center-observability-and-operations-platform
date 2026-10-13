import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { VmMetricsController } from './vm-metrics.controller.js';
import { VmMetricsService } from './vm-metrics.service.js';
describe('VM metrics read controller', () => {
  it('uses organization-bound cookie auth and vm.read permission for both reads', () => {
    expect(Reflect.getMetadata('path', VmMetricsController)).toBe(
      'organizations/:organizationId/vms/:vmId/metrics',
    );
    expect(Reflect.getMetadata('__guards__', VmMetricsController)).toEqual([
      CognitoAuthGuard,
      PermissionsGuard,
    ]);
    // Read metadata from descriptors without creating unbound method references.
    for (const name of ['current', 'range']) {
      const handler = Object.getOwnPropertyDescriptor(
        VmMetricsController.prototype,
        name,
      )?.value as object;
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
        'vm.read',
      ]);
    }
  });
  it('delegates only validated identity and whitelisted query DTO', async () => {
    const service = {
      current: vi.fn().mockResolvedValue({}),
      range: vi.fn().mockResolvedValue({}),
    };
    const controller = new VmMetricsController(
      service as unknown as VmMetricsService,
    );
    const params = { organizationId: 'o', vmId: 'v' };
    await controller.current(params);
    await controller.range(params, { range: '1h' });
    expect(service.current).toHaveBeenCalledWith('o', 'v');
    expect(service.range).toHaveBeenCalledWith('o', 'v', { range: '1h' });
  });
});
