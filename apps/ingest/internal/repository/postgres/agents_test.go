package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/jackc/pgx/v5"
)

const repositoryHash = "531b666a367143e6730a1ff4b897154ddede20987baaadfb0446bd19cad4c49c"

// This is a query-boundary expectation, not a source-text assertion: it checks
// the statement and parameters that FindByTokenHash submits to PostgreSQL.
const expectedAgentQuery = `SELECT a."id"::text, a."vmId"::text, a."organizationId"::text, a."status"::text
FROM "Agent" AS a
JOIN "Vm" AS v ON v."id" = a."vmId" AND v."organizationId" = a."organizationId"
JOIN "Organization" AS o ON o."id" = a."organizationId"
WHERE a."credentialHash" = $1`

type queryFunc func(context.Context, string, ...any) pgx.Row

func (f queryFunc) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return f(ctx, sql, args...)
}

type rowFunc func(...any) error

func (f rowFunc) Scan(dest ...any) error { return f(dest...) }

func agentRow(t *testing.T, status string) pgx.Row {
	t.Helper()
	return rowFunc(func(dest ...any) error {
		values := []string{"10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002", "30000000-0000-4000-8000-000000000003", status}
		if len(dest) != len(values) {
			t.Fatalf("scan destinations = %d, want 4", len(dest))
		}
		for i, value := range values {
			ptr, ok := dest[i].(*string)
			if !ok {
				t.Fatalf("scan destination %d is %T, want *string", i, dest[i])
			}
			*ptr = value
		}
		return nil
	})
}

func TestFindByTokenHashUsesReadOnlyTenantSafeParameterizedQuery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var queryCalls int
	db := queryFunc(func(gotCtx context.Context, sql string, args ...any) pgx.Row {
		queryCalls++
		if gotCtx != ctx {
			t.Fatal("repository replaced caller context")
		}
		if strings.Join(strings.Fields(sql), " ") != strings.Join(strings.Fields(expectedAgentQuery), " ") {
			t.Fatalf("unsafe or schema-mismatched query: %s", sql)
		}
		if !reflect.DeepEqual(args, []any{repositoryHash}) {
			t.Fatalf("query args = %#v, want single credential hash", args)
		}
		if strings.Contains(sql, repositoryHash) {
			t.Fatal("hash interpolated into SQL")
		}
		return agentRow(t, "ACTIVE")
	})
	got, err := (&Agents{db: db}).FindByTokenHash(ctx, repositoryHash)
	want := auth.Agent{AgentID: "10000000-0000-4000-8000-000000000001", VMID: "20000000-0000-4000-8000-000000000002", OrganizationID: "30000000-0000-4000-8000-000000000003", Status: "ACTIVE"}
	if err != nil || got != want || queryCalls != 1 {
		t.Fatalf("FindByTokenHash = %#v, %v; calls=%d", got, err, queryCalls)
	}
}

func TestFindByTokenHashPreservesRevokedStatusForAuthenticationRejection(t *testing.T) {
	db := queryFunc(func(context.Context, string, ...any) pgx.Row { return agentRow(t, "REVOKED") })
	got, err := (&Agents{db: db}).FindByTokenHash(context.Background(), repositoryHash)
	if err != nil || got.Status != "REVOKED" {
		t.Fatalf("revoked row = %#v, %v", got, err)
	}
}

func TestFindByTokenHashMapsNoRowsAndDiscardsPartialMetadata(t *testing.T) {
	for _, tc := range []struct {
		name            string
		scanError, want error
	}{
		{"missing", pgx.ErrNoRows, auth.ErrNotFound},
		{"wrapped_missing", errors.Join(errors.New("query details"), pgx.ErrNoRows), auth.ErrNotFound},
		{"database_failure", errors.New("database failure"), nil},
		{"deadline", context.DeadlineExceeded, context.DeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := queryFunc(func(context.Context, string, ...any) pgx.Row {
				return rowFunc(func(dest ...any) error { *dest[0].(*string) = "partial metadata"; return tc.scanError })
			})
			got, err := (&Agents{db: db}).FindByTokenHash(context.Background(), repositoryHash)
			want := tc.want
			if want == nil {
				want = tc.scanError
			}
			if err != want || got != (auth.Agent{}) {
				t.Fatalf("scan error = %#v, %v; want %v", got, err, want)
			}
		})
	}
}
