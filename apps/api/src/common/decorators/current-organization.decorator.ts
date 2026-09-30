import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type {
  RequestContext,
  RequestOrganizationContext,
} from '../types/request-context.type.js';

export type OrganizationContext = RequestOrganizationContext;
type OrganizationContextKey = keyof RequestOrganizationContext;
type OrganizationContextValue =
  | RequestOrganizationContext
  | RequestOrganizationContext[OrganizationContextKey]
  | undefined;

export const CurrentOrganization = createParamDecorator(
  (
    data: OrganizationContextKey | undefined,
    context: ExecutionContext,
  ): OrganizationContextValue => {
    const request = context.switchToHttp().getRequest<RequestContext>();
    const organization = request.organization;

    if (!data || !organization) {
      return organization;
    }

    return organization[data];
  },
);
