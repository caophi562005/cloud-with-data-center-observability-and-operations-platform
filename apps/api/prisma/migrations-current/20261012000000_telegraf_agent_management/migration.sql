-- Additive migration; do not execute against deployed databases without approval.
BEGIN;

CREATE TYPE "AgentCollectorType" AS ENUM ('ALLOY', 'TELEGRAF');
CREATE TYPE "EnrollmentTokenScope" AS ENUM ('VM', 'ORGANIZATION');

-- The default backfills all existing, VM-bound tokens without changing their TTL.
ALTER TABLE "EnrollmentToken"
  ADD COLUMN "scope" "EnrollmentTokenScope" NOT NULL DEFAULT 'VM',
  ALTER COLUMN "vmId" DROP NOT NULL;
ALTER TABLE "EnrollmentToken" ADD CONSTRAINT "EnrollmentToken_scope_vmId_check"
  CHECK (("scope" = 'VM' AND "vmId" IS NOT NULL)
      OR ("scope" = 'ORGANIZATION' AND "vmId" IS NULL));
CREATE INDEX "EnrollmentToken_organizationId_scope_status_expiresAt_idx"
  ON "EnrollmentToken"("organizationId", "scope", "status", "expiresAt");

-- Legacy collector and configuration state remain unknown, not implicitly Telegraf.
ALTER TABLE "Agent"
  ADD COLUMN "collectorType" "AgentCollectorType",
  ADD COLUMN "collectorVersion" VARCHAR(128),
  ADD COLUMN "buildId" VARCHAR(128),
  ADD COLUMN "appliedConfigVersion" INTEGER,
  ADD COLUMN "appliedConfigHash" VARCHAR(64),
  ADD COLUMN "appliedConfigAt" TIMESTAMP(3),
  ADD COLUMN "rejectedConfigVersion" INTEGER,
  ADD COLUMN "rejectedConfigError" TEXT,
  ADD COLUMN "lastControlContactAt" TIMESTAMP(3);

CREATE TABLE "VmMonitoringConfig" (
  "vmId" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "profileKey" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "secretsCiphertext" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VmMonitoringConfig_pkey" PRIMARY KEY ("vmId"),
  CONSTRAINT "VmMonitoringConfig_organizationId_vmId_fkey"
    FOREIGN KEY ("organizationId", "vmId") REFERENCES "Vm"("organizationId", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VmMonitoringConfig_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VmMonitoringConfig_organizationId_vmId_key"
  ON "VmMonitoringConfig"("organizationId", "vmId");
CREATE INDEX "VmMonitoringConfig_organizationId_idx" ON "VmMonitoringConfig"("organizationId");

COMMIT;
