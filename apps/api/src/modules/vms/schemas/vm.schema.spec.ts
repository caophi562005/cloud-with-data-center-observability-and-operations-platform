import { describe, expect, it } from 'vitest';
import { enrollmentSchema } from './enrollment.schema.js';
import {
  vmCreateSchema,
  vmListQuerySchema,
  vmOrganizationParamsSchema,
  vmParamsSchema,
  vmTagSchema,
  vmUpdateSchema,
} from './vm.schema.js';

describe('VM schemas', () => {
  it('normalizes bounded hostname and tags', () => {
    expect(vmCreateSchema.parse({ hostname: '  DB-Prod-01  ' }).hostname).toBe(
      'db-prod-01',
    );
    expect(vmTagSchema.parse({ key: ' Env ', value: ' Production ' })).toEqual({
      key: 'env',
      value: 'production',
    });
  });

  it('rejects VM payloads that contain server-managed fields', () => {
    expect(() =>
      vmCreateSchema.parse({ hostname: 'db-prod-01', os: 'Ubuntu' }),
    ).toThrow();
    expect(() =>
      vmUpdateSchema.parse({ hostname: 'db-prod-01', status: 'HEALTHY' }),
    ).toThrow();
  });

  it('accepts UUID route parameters and rejects malformed identifiers', () => {
    expect(
      vmOrganizationParamsSchema.parse({
        organizationId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual({
      organizationId: '00000000-0000-4000-8000-000000000001',
    });
    expect(() =>
      vmParamsSchema.parse({ organizationId: 'org', vmId: 'vm' }),
    ).toThrow();
  });

  it('accepts valid IPv4 and IPv6 addresses but rejects invalid addresses', () => {
    expect(
      vmCreateSchema.parse({
        hostname: 'db-prod-01',
        ipAddress: ' 2001:db8::1 ',
      }),
    ).toEqual({ hostname: 'db-prod-01', ipAddress: '2001:db8::1' });
    expect(() =>
      vmCreateSchema.parse({ hostname: 'db-prod-01', ipAddress: 'not-an-ip' }),
    ).toThrow();
  });

  it('allows an update to clear the IP address and requires a changed field', () => {
    expect(vmUpdateSchema.parse({ ipAddress: null })).toEqual({
      ipAddress: null,
    });
    expect(() => vmUpdateSchema.parse({})).toThrow();
  });

  it('normalizes list tags to unique key:value filters with bounded paging', () => {
    expect(
      vmListQuerySchema.parse({
        tag: [' Env : Production ', ' Role : Database '],
        page: '2',
        pageSize: '25',
      }),
    ).toEqual({
      page: 2,
      pageSize: 25,
      tag: ['env:production', 'role:database'],
    });
    expect(vmListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 50,
    });
    expect(() =>
      vmListQuerySchema.parse({ tag: ['env:production', 'env:production'] }),
    ).toThrow();
    expect(() => vmListQuerySchema.parse({ pageSize: 101 })).toThrow();
  });

  it('rejects organization identity fields from tag and VM bodies', () => {
    expect(() =>
      vmTagSchema.parse({
        key: 'env',
        value: 'production',
        organizationId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow();
    expect(() =>
      vmUpdateSchema.parse({
        ipAddress: null,
        organizationId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow();
  });

  it('normalizes valid enrollment tokens and operating-system metadata', () => {
    expect(
      enrollmentSchema.parse({
        token: `ENR_${'a'.repeat(43)}`,
        os: ' Ubuntu 24.04 ',
      }),
    ).toEqual({ token: `ENR_${'a'.repeat(43)}`, os: 'Ubuntu 24.04' });
  });

  it('rejects enrollment organization and VM identifiers and invalid tokens', () => {
    expect(() =>
      enrollmentSchema.parse({
        token: `ENR_${'a'.repeat(43)}`,
        organizationId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toThrow();
    expect(() =>
      enrollmentSchema.parse({
        token: `ENR_${'a'.repeat(43)}`,
        vmId: '00000000-0000-4000-8000-000000000002',
      }),
    ).toThrow();
    expect(() => enrollmentSchema.parse({ token: 'ENR_invalid' })).toThrow();
  });
});
