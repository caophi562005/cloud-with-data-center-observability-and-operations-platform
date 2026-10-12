import { describe, expect, it } from 'vitest';
import { requireIsolatedPostgresTestUrl } from './alert-operations-postgres.js';

const url =
  'postgresql://fixture:fixture@127.0.0.1:53099/opsgrid_alert_operations_test';
describe('isolated PostgreSQL target guard', () => {
  it('accepts only an explicitly opted-in scratch target', () => {
    expect(
      requireIsolatedPostgresTestUrl({
        ALERT_OPERATIONS_TEST_ALLOW_WRITE: '1',
        ALERT_OPERATIONS_TEST_DATABASE_URL: url,
      }),
    ).toBe(url);
  });
  it.each([
    {},
    { DATABASE_URL: url, ALERT_OPERATIONS_TEST_ALLOW_WRITE: '1' },
    { ALERT_OPERATIONS_TEST_DATABASE_URL: url },
    {
      ALERT_OPERATIONS_TEST_ALLOW_WRITE: 'true',
      ALERT_OPERATIONS_TEST_DATABASE_URL: url,
    },
    ...[
      url.replace('127.0.0.1', 'db.example.com'),
      url.replace('127.0.0.1', 'localhost'),
      url.replace('opsgrid_alert_operations_test', 'application'),
      url.replace(':53099', ''),
      url.replace(':53099', ':1'),
      url.replace('postgresql:', 'https:'),
      url + '?host=remote.example.com',
      url + '#fragment',
      'invalid secret-canary',
    ].map((value) => ({
      ALERT_OPERATIONS_TEST_ALLOW_WRITE: '1',
      ALERT_OPERATIONS_TEST_DATABASE_URL: value,
    })),
  ])(
    'refuses unsafe or ambient targets without exposing credentials',
    (environment) => {
      expect(() => requireIsolatedPostgresTestUrl(environment)).toThrow(
        'Isolated PostgreSQL test target required',
      );
      try {
        requireIsolatedPostgresTestUrl(environment);
      } catch (error) {
        expect(String(error)).not.toMatch(
          /fixture:fixture|secret-canary|db\.example|application/,
        );
      }
    },
  );
});
