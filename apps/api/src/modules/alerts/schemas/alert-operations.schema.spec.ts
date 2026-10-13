import { describe, expect, it } from 'vitest';
import {
  alertParamsSchema,
  alertOrganizationParamsSchema,
  alertListQuerySchema,
  alertEventsQuerySchema,
  alertAcknowledgeSchema,
  alertCommentSchema,
} from './alert-operations.schema.js';

const organizationId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
describe('alert operation schemas', () => {
  it('validates UUID selectors and exact query defaults/filters', () => {
    expect(alertOrganizationParamsSchema.parse({ organizationId })).toEqual({
      organizationId,
    });
    expect(alertParamsSchema.parse({ organizationId, id })).toEqual({
      organizationId,
      id,
    });
    expect(alertListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(
      alertListQuerySchema.parse({
        page: '2',
        pageSize: '100',
        signalStatus: 'RESOLVED',
        workflowStatus: 'ACKNOWLEDGED',
        severity: 'CRITICAL',
        vmId: id,
      }),
    ).toEqual({
      page: 2,
      pageSize: 100,
      signalStatus: 'RESOLVED',
      workflowStatus: 'ACKNOWLEDGED',
      severity: 'CRITICAL',
      vmId: id,
    });
    expect(alertEventsQuerySchema.parse({ page: '3', pageSize: '5' })).toEqual({
      page: 3,
      pageSize: 5,
    });
  });
  it.each([
    { id: 'invalid', organizationId },
    { id, organizationId: 'invalid' },
    { id, organizationId, actorId: id },
  ])('rejects malformed/extended params %j', (input) => {
    expect(alertParamsSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    { page: '0' },
    { page: '-1' },
    { page: '1.5' },
    { page: 'Infinity' },
    { page: Infinity },
    { page: NaN },
    { page: false },
    { page: ['1', '2'] },
    { page: '' },
    { page: '1e2' },
    { pageSize: '101' },
    { page: '2147483647', pageSize: '100' },
    { page: '9007199254740993' },
    { severity: 'LOW' },
    { signalStatus: 'OPEN' },
    { workflowStatus: 'RESOLVED' },
    { vmId: 'invalid' },
    { organizationId },
    { search: 'text' },
  ])('rejects invalid filters or unsafe page arithmetic %j', (query) => {
    expect(alertListQuerySchema.safeParse(query).success).toBe(false);
  });
  it('accepts trimmed literal search and every explicit sort without adding a default sort', () => {
    expect(
      alertListQuerySchema.parse({
        q: '  Edge_%\\host  ',
        sort: 'severity_desc',
      }),
    ).toEqual({
      page: 1,
      pageSize: 50,
      q: 'Edge_%\\host',
      sort: 'severity_desc',
    });
    for (const sort of ['severity_desc', 'started_at_desc', 'started_at_asc'])
      expect(alertListQuerySchema.parse({ sort })).toEqual({
        page: 1,
        pageSize: 50,
        sort,
      });
    expect(alertListQuerySchema.parse({ q: 'x'.repeat(120) }).q).toHaveLength(
      120,
    );
    expect(alertListQuerySchema.parse({})).not.toHaveProperty('sort');
  });
  it.each([
    { q: '' },
    { q: '  ' },
    { q: 'x'.repeat(121) },
    { q: ['cpu', 'memory'] },
    { q: 1 },
    { sort: 'latest' },
    { sort: ['severity_desc'] },
    { organizationId },
  ])('rejects invalid search/sort or client tenancy %j', (query) => {
    expect(alertListQuerySchema.safeParse(query).success).toBe(false);
  });
  it('accepts only undefined or the empty acknowledgement body', () => {
    expect(alertAcknowledgeSchema.parse(undefined)).toBeUndefined();
    expect(alertAcknowledgeSchema.parse({})).toEqual({});
    for (const value of [
      null,
      [],
      { actorId: id },
      { status: 'RESOLVED' },
      { organizationId },
      { message: 'note' },
    ])
      expect(alertAcknowledgeSchema.safeParse(value).success).toBe(false);
  });
  it('retains trimmed plain Unicode/multiline text without interpreting it', () => {
    expect(
      alertCommentSchema.parse({ message: '  <b>你好 😀</b>\n\t+ "note"  ' }),
    ).toEqual({ message: '<b>你好 😀</b>\n\t+ "note"' });
    expect(
      alertCommentSchema.parse({ message: '😀'.repeat(4000) }).message,
    ).toHaveLength(8000);
    expect(
      alertCommentSchema.parse({ message: 'x'.repeat(4000) }).message,
    ).toHaveLength(4000);
  });
  it.each([
    '',
    ' \t\n ',
    'x'.repeat(4001),
    '😀'.repeat(4001),
    '\u0000',
    'prefix\ud800',
    '\udc00suffix',
  ])('rejects empty, oversized or invalid Unicode text', (message) => {
    expect(alertCommentSchema.safeParse({ message }).success).toBe(false);
  });
  it('rejects client actor, tenancy, timestamp and extra mutation fields', () => {
    for (const extra of [
      { actorId: id },
      { organizationId },
      { severity: 'WARNING' },
      { createdAt: '2026-10-10' },
      { workflowStatus: 'ACKNOWLEDGED' },
    ])
      expect(
        alertCommentSchema.safeParse({ message: 'note', ...extra }).success,
      ).toBe(false);
    expect(
      alertEventsQuerySchema.safeParse({ severity: 'WARNING' }).success,
    ).toBe(false);
  });
});
