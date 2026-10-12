import { describe, expect, it } from 'vitest';
import {
  isAuthRateLimitedRoute,
  isEnrollmentRateLimitedRoute,
  throttling,
} from './app.module.js';

type HttpContext = {
  switchToHttp: () => {
    getRequest: () => { path: string };
  };
};

const httpContext = (path: string): HttpContext => ({
  switchToHttp: () => ({ getRequest: () => ({ path }) }),
});

describe('AppModule throttling', () => {
  it('selects the strict enrollment bucket only for the public endpoint', () => {
    expect(
      isEnrollmentRateLimitedRoute(httpContext('/api/v1/agent-enrollment')),
    ).toBe(true);
    expect(
      isEnrollmentRateLimitedRoute(
        httpContext('/api/v1/organizations/org/vms'),
      ),
    ).toBe(false);
    expect(
      isEnrollmentRateLimitedRoute(
        httpContext('/api/v1/agent-enrollment/reissue'),
      ),
    ).toBe(false);
  });

  it('preserves the existing auth route predicate', () => {
    expect(isAuthRateLimitedRoute(httpContext('/api/v1/auth/login'))).toBe(
      true,
    );
    expect(isAuthRateLimitedRoute(httpContext('/api/v1/auth/refresh'))).toBe(
      true,
    );
    expect(
      isAuthRateLimitedRoute(httpContext('/api/v1/agent-enrollment')),
    ).toBe(false);
  });

  it('exports the configured throttling limits', () => {
    expect(throttling).toEqual({
      windowMs: 60_000,
      authLimit: 10,
      generalLimit: 120,
      enrollmentLimit: 10,
    });
  });
});
