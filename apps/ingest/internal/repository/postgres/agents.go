// Package postgres contains read-only agent credential lookups.
package postgres

import (
	"context"
	"errors"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Keep the database boundary narrow so query/scan behavior is testable without
// a writable database or a second public constructor.
type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type Agents struct{ db queryRower }

func NewAgents(pool *pgxpool.Pool) *Agents { return &Agents{db: pool} }

const findAgentByTokenHash = `
SELECT a."id"::text, a."vmId"::text, a."organizationId"::text, a."status"::text
FROM "Agent" AS a
JOIN "Vm" AS v ON v."id" = a."vmId" AND v."organizationId" = a."organizationId"
JOIN "Organization" AS o ON o."id" = a."organizationId"
WHERE a."credentialHash" = $1`

func (r *Agents) FindByTokenHash(ctx context.Context, hash string) (auth.Agent, error) {
	var agent auth.Agent
	err := r.db.QueryRow(ctx, findAgentByTokenHash, hash).Scan(
		&agent.AgentID, &agent.VMID, &agent.OrganizationID, &agent.Status,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Agent{}, auth.ErrNotFound
	}
	if err != nil {
		return auth.Agent{}, err
	}
	return agent, nil
}

var _ auth.Repository = (*Agents)(nil)
