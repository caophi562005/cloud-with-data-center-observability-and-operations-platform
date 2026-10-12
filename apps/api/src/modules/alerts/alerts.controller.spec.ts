import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertOrganizationGuard,
  AlertsController,
} from './alerts.controller.js';
import { AlertService } from './alert.service.js';
import { CognitoAuthGuard } from '../auth/guards/cognito-auth.guard.js';
import { PermissionsGuard } from '../authorization/guards/permissions.guard.js';
import { PERMISSIONS_KEY } from '../../common/decorators/require-permissions.decorator.js';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { SKIP_CSRF_KEY } from '../../common/decorators/skip-csrf.decorator.js';
import { SnsAlertsController } from './sns/sns-alerts.controller.js';

describe('alert operations controller security metadata', () => {
  it('has Cognito/membership guards and never broadens the public SNS boundary', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AlertsController)).toEqual([
      CognitoAuthGuard,
      AlertOrganizationGuard,
      PermissionsGuard,
    ]);
    for (const target of [
      AlertsController,
      ...['list', 'get', 'events', 'acknowledge', 'comment'].map(
        (name) => AlertsController.prototype[name as keyof AlertsController],
      ),
    ]) {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, target)).not.toBe(true);
      expect(Reflect.getMetadata(SKIP_CSRF_KEY, target)).not.toBe(true);
    }
    for (const method of ['list', 'get', 'events'] as const)
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          AlertsController.prototype[method],
        ),
      ).toEqual(['alert.read']);
    for (const method of ['acknowledge', 'comment'] as const)
      expect(
        Reflect.getMetadata(
          PERMISSIONS_KEY,
          AlertsController.prototype[method],
        ),
      ).toEqual(['alert.manage']);
    expect(
      Reflect.getMetadata(
        IS_PUBLIC_KEY,
        Reflect.get(SnsAlertsController.prototype, 'receive'),
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        SKIP_CSRF_KEY,
        Reflect.get(SnsAlertsController.prototype, 'receive'),
      ),
    ).toBe(true);
  });
  it('forwards the trusted local actor to the same domain service without any subject/body identity', async () => {
    const service = {
      acknowledge: vi.fn().mockResolvedValue({}),
      comment: vi.fn().mockResolvedValue({}),
    };
    const controller = new AlertsController(service as unknown as AlertService);
    await controller.acknowledge(
      { organizationId: 'org', id: 'alert' },
      'local-uuid',
      {},
    );
    await controller.comment(
      { organizationId: 'org', id: 'alert' },
      'local-uuid',
      {
        message: 'note',
      },
    );
    expect(service.acknowledge).toHaveBeenCalledWith(
      'org',
      'alert',
      'local-uuid',
    );
    expect(service.comment).toHaveBeenCalledWith('org', 'alert', 'local-uuid', {
      message: 'note',
    });
  });
});
