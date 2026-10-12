import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApplicationNotFoundError } from '../../common/errors/application-conflict.error.js';
import { AlertRepository } from './alert.repository.js';
import { occurrenceKey } from './alert-lifecycle.js';
import {
  AlertInputError,
  type CanonicalAlertEvent,
  type AlertBatchResult,
} from './alert.types.js';
import type {
  AlertListQuery,
  AlertEventsQuery,
  AlertCommentInput,
} from './schemas/alert-operations.schema.js';
import {
  toAlertSummary,
  toAlertDetail,
  toAlertEvent,
  type AlertDetailDto,
  type AlertSummaryDto,
  type AlertEventDto,
  type AlertPage,
} from './alert-operations.dto.js';

@Injectable()
export class AlertService {
  constructor(private readonly repository: AlertRepository) {}

  private async persistence<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new ServiceUnavailableException();
    }
  }
  private requireParent<T>(value: T | null): T {
    if (value === null)
      throw new ApplicationNotFoundError(
        'RESOURCE_NOT_FOUND',
        'Resource not found',
      );
    return value;
  }
  private requireActor(actorUserId: string): void {
    if (!actorUserId) throw new UnauthorizedException();
  }
  async list(
    organizationId: string,
    query: AlertListQuery,
  ): Promise<AlertPage<AlertSummaryDto>> {
    const result = await this.persistence(() =>
      this.repository.list(organizationId, query),
    );
    return {
      items: result.rows.map(toAlertSummary),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async get(organizationId: string, id: string): Promise<AlertDetailDto> {
    return toAlertDetail(
      this.requireParent(
        await this.persistence(() => this.repository.get(organizationId, id)),
      ),
    );
  }
  async events(
    organizationId: string,
    id: string,
    query: AlertEventsQuery,
  ): Promise<AlertPage<AlertEventDto>> {
    const result = this.requireParent(
      await this.persistence(() =>
        this.repository.events(organizationId, id, query),
      ),
    );
    return {
      items: result.rows.map(toAlertEvent),
      total: result.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
  async acknowledge(
    organizationId: string,
    id: string,
    actorUserId: string,
  ): Promise<AlertDetailDto> {
    this.requireActor(actorUserId);
    return toAlertDetail(
      this.requireParent(
        await this.persistence(() =>
          this.repository.acknowledge(
            organizationId,
            id,
            actorUserId,
            Date.now() + 5000,
          ),
        ),
      ),
    );
  }
  async comment(
    organizationId: string,
    id: string,
    actorUserId: string,
    input: AlertCommentInput,
  ): Promise<AlertEventDto> {
    this.requireActor(actorUserId);
    return toAlertEvent(
      this.requireParent(
        await this.persistence(() =>
          this.repository.comment(
            organizationId,
            id,
            actorUserId,
            input.message,
            Date.now() + 5000,
          ),
        ),
      ),
    );
  }
  ingest(
    events: readonly CanonicalAlertEvent[],
    deadlineAt: number,
  ): Promise<AlertBatchResult> {
    if (
      events.length < 1 ||
      events.length > 100 ||
      new Set(events.map(occurrenceKey)).size !== events.length
    )
      throw new AlertInputError();
    return this.repository.persistBatch(events, deadlineAt);
  }
}
