BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "AlertWorkflowStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED');
CREATE TYPE "AlertEventType" AS ENUM ('ALERT_FIRING', 'ACKNOWLEDGED', 'COMMENT_ADDED', 'ALERT_RESOLVED');

ALTER TABLE "alerts"
  ADD COLUMN "workflowStatus" "AlertWorkflowStatus" NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "acknowledgedBy" UUID,
  ADD COLUMN "acknowledgedAt" TIMESTAMPTZ(6),
  ADD CONSTRAINT "alerts_acknowledgement_shape" CHECK (
    ("workflowStatus" = 'OPEN' AND "acknowledgedBy" IS NULL AND "acknowledgedAt" IS NULL) OR
    ("workflowStatus" = 'ACKNOWLEDGED' AND "acknowledgedBy" IS NOT NULL AND "acknowledgedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "alerts_acknowledgedBy_fkey" FOREIGN KEY ("acknowledgedBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "alert_events" (
  "id" UUID NOT NULL,
  "alertId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "AlertEventType" NOT NULL,
  "actorId" UUID,
  "message" TEXT,
  "sourceTimeKey" VARCHAR(30),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "alert_events_positive_sequence" CHECK ("sequence" > 0),
  CONSTRAINT "alert_events_shape" CHECK (
    ("type" IN ('ALERT_FIRING', 'ALERT_RESOLVED') AND "actorId" IS NULL AND "message" IS NULL AND "sourceTimeKey" IS NOT NULL) OR
    ("type" = 'ACKNOWLEDGED' AND "actorId" IS NOT NULL AND "message" IS NULL AND "sourceTimeKey" IS NULL) OR
    ("type" = 'COMMENT_ADDED' AND "actorId" IS NOT NULL AND "message" IS NOT NULL AND "sourceTimeKey" IS NULL
      AND char_length(btrim("message")) BETWEEN 1 AND 4000 AND octet_length("message") <= 16384)
  ),
  CONSTRAINT "alert_events_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "alert_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "alert_events_alertId_sequence_key" ON "alert_events"("alertId", "sequence");
CREATE INDEX "alerts_organizationId_workflowStatus_createdAt_idx" ON "alerts"("organizationId", "workflowStatus", "createdAt");

COMMIT;
