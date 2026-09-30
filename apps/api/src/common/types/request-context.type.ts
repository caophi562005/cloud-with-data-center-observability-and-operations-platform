import type { Request } from 'express';
import type { AuthenticatedUser } from './authenticated-user.type.js';

export type RequestOrganizationContext = {
  id: string;
  organizationId?: string;
  userId?: string;
  name?: string;
  slug?: string;
  role?: string;
  permissions?: string[];
};

export type RequestContext = Request & {
  id?: string;
  requestId?: string;
  user?: AuthenticatedUser;
  organization?: RequestOrganizationContext;
};
