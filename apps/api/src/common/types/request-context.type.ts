import type { Request } from 'express';
import type { AuthenticatedUser } from './authenticated-user.type.js';
import type { AgentIdentity } from '../../modules/vms/monitoring/monitoring.types.js';

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
  agentIdentity?: AgentIdentity;
  organization?: RequestOrganizationContext;
};
