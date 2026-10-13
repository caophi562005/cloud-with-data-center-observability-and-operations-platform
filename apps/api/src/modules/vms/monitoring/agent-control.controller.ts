import { Body, Controller, Get, Header, Headers, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { SkipCsrf } from '../../../common/decorators/skip-csrf.decorator.js';
import type { RequestContext } from '../../../common/types/request-context.type.js';
import { AgentAuthGuard } from '../agent-auth.guard.js';
import { validateAgentApplyReport, validateNativeHeartbeat } from './agent-control.schema.js';
import { MonitoringService, monitoringConfigEtag } from './monitoring.service.js';
import type { AgentIdentity } from './monitoring.types.js';

@Controller('agent')
@Public()
@SkipCsrf()
@UseGuards(AgentAuthGuard)
export class AgentControlController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('config')
  @Header('Cache-Control', 'no-store')
  async config(
    @Req() request: RequestContext,
    @Headers('if-none-match') etag: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const envelope = await this.monitoring.getAgentConfig(this.identity(request), etag);
    response.setHeader('Cache-Control', 'no-store');
    if (envelope === null) {
      // Service returns null ONLY on an exact strong version+hash ETag match.
      response.setHeader('ETag', etag!);
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }
    response.setHeader('ETag', monitoringConfigEtag(envelope));
    // end() rather than Express send/json: Express freshness processing would
    // otherwise turn wildcard/weak/list If-None-Match into an implicit 304.
    response.status(HttpStatus.OK).type('application/json').end(JSON.stringify(envelope));
  }

  @Post('config-result')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  async configResult(@Req() request: RequestContext, @Body() input: unknown): Promise<void> {
    await this.monitoring.recordApply(this.identity(request), validateAgentApplyReport(input));
  }

  @Post('heartbeat')
  @Header('Cache-Control', 'no-store')
  @HttpCode(HttpStatus.NO_CONTENT)
  async heartbeat(@Req() request: RequestContext, @Body() input: unknown): Promise<void> {
    await this.monitoring.recordHeartbeat(this.identity(request), validateNativeHeartbeat(input));
  }

  private identity(request: RequestContext): AgentIdentity {
    if (!request.agentIdentity) throw new UnauthorizedException();
    return request.agentIdentity;
  }
}
