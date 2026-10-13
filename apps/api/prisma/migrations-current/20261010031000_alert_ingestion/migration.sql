-- Additive alert schema only; keep PostgreSQL DDL atomic and bounded.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('FIRING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "source" VARCHAR(64) NOT NULL,
    "organizationId" UUID NOT NULL,
    "vmId" UUID NOT NULL,
    "fingerprint" VARCHAR(128) NOT NULL,
    "alertName" VARCHAR(128) NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6),
    "startsAtKey" VARCHAR(30) NOT NULL,
    "endsAtKey" VARCHAR(30),
    "labels" JSONB NOT NULL,
    "annotations" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alerts_organizationId_status_startsAt_idx" ON "alerts"("organizationId", "status", "startsAt");

-- CreateIndex
CREATE INDEX "alerts_organizationId_vmId_startsAt_idx" ON "alerts"("organizationId", "vmId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_occurrence_key" ON "alerts"("source", "organizationId", "vmId", "fingerprint", "startsAtKey");

-- CreateIndex
CREATE UNIQUE INDEX "Vm_organizationId_id_key" ON "Vm"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organizationId_vmId_fkey" FOREIGN KEY ("organizationId", "vmId") REFERENCES "Vm"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
