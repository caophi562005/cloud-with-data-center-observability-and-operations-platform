import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { RequestContext } from '../../common/types/request-context.type.js';
import { AgentAuthService } from './agent-auth.service.js';

@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly agentAuthService: AgentAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestContext>();
    // Never leave a caller-provided or stale identity on a failed authentication.
    delete request.agentIdentity;
    request.agentIdentity = await this.agentAuthService.authenticate(
      request.headers.authorization,
    );
    return true;
  }
}
