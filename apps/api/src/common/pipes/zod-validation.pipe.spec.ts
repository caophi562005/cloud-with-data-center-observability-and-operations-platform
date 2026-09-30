import { BadRequestException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { CurrentOrganization } from '../decorators/current-organization.decorator.js';
import { CurrentUser } from '../decorators/current-user.decorator.js';
import { IS_PUBLIC_KEY, Public } from '../decorators/public.decorator.js';
import {
  PERMISSIONS_KEY,
  RequirePermissions,
} from '../decorators/require-permissions.decorator.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  it('parses valid input with the supplied schema', () => {
    const pipe = new ZodValidationPipe(z.object({ email: z.string().email() }));

    expect(pipe.transform({ email: 'operator@example.com' })).toEqual({
      email: 'operator@example.com',
    });
  });

  it('throws a safe validation exception containing field issues', () => {
    const pipe = new ZodValidationPipe(
      z.object({
        email: z.string().email(),
        password: z.string().min(8),
      }),
    );

    let thrown: unknown;
    try {
      pipe.transform({ email: 'not-an-email', password: 'secret' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    const response = (thrown as BadRequestException).getResponse();
    expect(response).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    });
    expect(response).toHaveProperty('details.issues');
    expect(JSON.stringify(response)).not.toContain('secret');
    expect(JSON.stringify(response)).not.toContain('stack');
  });

  it('sanitizes custom Zod messages that could contain credentials', () => {
    const pipe = new ZodValidationPipe(
      z.object({
        password: z.string().refine(() => false, {
          message: 'password=super-secret-token',
        }),
      }),
    );

    let thrown: unknown;
    try {
      pipe.transform({ password: 'super-secret-token' });
    } catch (error) {
      thrown = error;
    }

    const response = (thrown as BadRequestException).getResponse();
    expect(response).toMatchObject({
      details: { issues: [{ message: 'Invalid value' }] },
    });
    expect(JSON.stringify(response)).not.toContain('super-secret-token');
  });
});

describe('request metadata decorators', () => {
  it('marks public handlers with public metadata', () => {
    class PublicController {
      @Public()
      handler(this: void) {}
    }

    expect(
      Reflect.getMetadata(IS_PUBLIC_KEY, PublicController.prototype.handler),
    ).toBe(true);
  });

  it('stores required permissions as typed metadata', () => {
    class OrganizationController {
      @RequirePermissions('organization.read', 'member.read')
      handler(this: void) {}
    }

    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        OrganizationController.prototype.handler,
      ),
    ).toEqual(['organization.read', 'member.read']);
  });

  it('provides current request user and organization values', () => {
    const user = {
      cognitoSub: 'sub-1',
      clientId: 'client-1',
      tokenUse: 'access' as const,
    };
    const organization = { id: 'org-1', role: 'VIEWER' };
    class TenantController {
      handler(
        @CurrentUser() _user: unknown,
        @CurrentUser('cognitoSub') _sub: unknown,
        @CurrentOrganization() _organization: unknown,
        @CurrentOrganization('id') _organizationId: unknown,
      ) {}
    }
    const metadata = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      TenantController,
      'handler',
    ) as Record<
      string,
      { data?: unknown; factory: (data: unknown, context: unknown) => unknown }
    >;
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ user, organization }),
      }),
    };

    const values = Object.values(metadata).map(({ data, factory }) =>
      factory(data, context),
    );
    expect(values).toContain(user);
    expect(values).toContain('sub-1');
    expect(values).toContain(organization);
    expect(values).toContain('org-1');
  });
});
