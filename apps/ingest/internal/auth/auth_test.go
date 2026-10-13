package auth

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

const testHash = "531b666a367143e6730a1ff4b897154ddede20987baaadfb0446bd19cad4c49c"

func activeAgent() Agent {
	return Agent{
		AgentID:        "10000000-0000-4000-8000-000000000001",
		VMID:           "20000000-0000-4000-8000-000000000002",
		OrganizationID: "30000000-0000-4000-8000-000000000003",
		Status:         "ACTIVE",
	}
}

func TestHashTokenMatchesNodeFixtures(t *testing.T) {
	for _, tc := range []struct{ token, want string }{
		{"AGT_test", "531b666a367143e6730a1ff4b897154ddede20987baaadfb0446bd19cad4c49c"},
		{"AGT_Mixed_CASE-123", "b65901a306d8eb942948f22a446d9f32703e2a159631e4e46e8dce02dbb7f95c"},
		{"AGT_é", "55e293e753c5e7bd32f8def323fcdaa17e4f437c1bece56562c4f3d82fc27564"},
	} {
		t.Run(tc.token, func(t *testing.T) {
			if got := HashToken(tc.token); got != tc.want {
				t.Fatalf("hash = %q, want %q", got, tc.want)
			}
		})
	}
	if HashToken(" AGT_test") == testHash || HashToken("AGT_TEST") == testHash {
		t.Fatal("hash helper modified plaintext")
	}
}

func TestParseBearerPreservesValidPlaintext(t *testing.T) {
	for _, tc := range []struct{ header, want string }{
		{"Bearer AGT_test", "AGT_test"},
		{"bEaReR AGT_Mixed_CASE-123", "AGT_Mixed_CASE-123"},
		{"BEARER AGT_a.b~c+d/e_-=", "AGT_a.b~c+d/e_-="},
		{"bearer AGT_a==", "AGT_a=="},
	} {
		t.Run(tc.header, func(t *testing.T) {
			got, err := ParseBearer(tc.header)
			if err != nil || got != tc.want {
				t.Fatalf("ParseBearer = %q, %v; want exact plaintext %q", got, err, tc.want)
			}
		})
	}
}

func TestParseBearerRejectsAmbiguousOrInvalidHeaders(t *testing.T) {
	for _, header := range []string{
		"", "Bearer", "Bearer ", "Bearer AGT_", "Bearer token", "Basic AGT_test",
		" Bearer AGT_test", "Bearer  AGT_test", "Bearer\tAGT_test", "Bearer AGT_test ",
		"Bearer AGT_te st", "Bearer AGT_test\t", "Bearer AGT_test\r\n", "Bearer AGT_é",
		"Bearer agt_test", "Bearer AGT_test,AGT_other", "Bearer AGT_test:extra",
		"Bearer AGT_a=b", "Bearer AGT_!", "Bearer AGT_a\x00", "Bearer AGT_test\u00a0",
	} {
		t.Run(header, func(t *testing.T) {
			got, err := ParseBearer(header)
			if !errors.Is(err, ErrUnauthorized) || got != "" {
				t.Fatalf("ParseBearer invalid header = %q, %v", got, err)
			}
		})
	}
}

type repositoryFunc func(context.Context, string) (Agent, error)

func (f repositoryFunc) FindByTokenHash(ctx context.Context, hash string) (Agent, error) {
	return f(ctx, hash)
}

type cacheStub struct {
	get func(context.Context, string) (Agent, bool, error)
	set func(context.Context, string, Agent, time.Duration) error
}

func (c cacheStub) Get(ctx context.Context, hash string) (Agent, bool, error) {
	return c.get(ctx, hash)
}
func (c cacheStub) Set(ctx context.Context, hash string, a Agent, ttl time.Duration) error {
	return c.set(ctx, hash, a, ttl)
}

func assertBoundedContext(t *testing.T, ctx context.Context, max time.Duration) {
	t.Helper()
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > max || time.Until(deadline) <= 0 {
		t.Fatalf("dependency context lacks a live deadline bounded to %v", max)
	}
}

func TestAuthenticateMissLooksUpHashAndCachesWithTTL(t *testing.T) {
	want := activeAgent()
	var dbCalls, cacheWrites int
	var dbContext, getContext, setContext context.Context
	repo := repositoryFunc(func(ctx context.Context, hash string) (Agent, error) {
		dbCalls++
		dbContext = ctx
		assertBoundedContext(t, ctx, 3*time.Second)
		if hash != testHash {
			t.Fatalf("DB received wrong hash %q", hash)
		}
		return want, nil
	})
	cache := cacheStub{
		get: func(ctx context.Context, hash string) (Agent, bool, error) {
			getContext = ctx
			assertBoundedContext(t, ctx, 250*time.Millisecond)
			if hash != testHash {
				t.Fatal("cache received plaintext or wrong hash")
			}
			return Agent{}, false, nil
		},
		set: func(ctx context.Context, hash string, got Agent, ttl time.Duration) error {
			cacheWrites++
			setContext = ctx
			assertBoundedContext(t, ctx, 250*time.Millisecond)
			if hash != testHash || got != want || ttl != 45*time.Second {
				t.Fatal("wrong cache write contract")
			}
			return nil
		},
	}
	got, err := NewService(repo, cache, 45*time.Second, nil).Authenticate(context.Background(), "Bearer AGT_test")
	if err != nil || got != want || dbCalls != 1 || cacheWrites != 1 {
		t.Fatalf("Authenticate = %#v, %v; calls=%d/%d", got, err, dbCalls, cacheWrites)
	}
	for _, ctx := range []context.Context{dbContext, getContext, setContext} {
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatal("dependency context not released")
		}
	}
}

func TestAuthenticateCacheHitSkipsDatabase(t *testing.T) {
	want := activeAgent()
	repo := repositoryFunc(func(context.Context, string) (Agent, error) { t.Fatal("DB called on cache hit"); return Agent{}, nil })
	cache := cacheStub{
		get: func(context.Context, string) (Agent, bool, error) { return want, true, nil },
		set: func(context.Context, string, Agent, time.Duration) error { t.Fatal("cache hit rewritten"); return nil },
	}
	got, err := NewService(repo, cache, time.Minute, nil).Authenticate(context.Background(), "Bearer AGT_test")
	if got != want || err != nil {
		t.Fatalf("cache authentication = %#v, %v", got, err)
	}
}

func TestAuthenticateRejectsInactiveOrInvalidMetadata(t *testing.T) {
	for _, mutation := range []struct {
		name   string
		mutate func(*Agent)
	}{
		{"revoked", func(a *Agent) { a.Status = "REVOKED" }},
		{"unknown_status", func(a *Agent) { a.Status = "UNKNOWN" }},
		{"lowercase_status", func(a *Agent) { a.Status = "active" }},
		{"missing_agent", func(a *Agent) { a.AgentID = "" }},
		{"missing_vm", func(a *Agent) { a.VMID = "" }},
		{"missing_organization", func(a *Agent) { a.OrganizationID = "" }},
		{"invalid_agent", func(a *Agent) { a.AgentID = "not-a-uuid" }},
		{"invalid_vm", func(a *Agent) { a.VMID = "20000000-0000-4000-8000-00000000000g" }},
		{"whitespace_organization", func(a *Agent) { a.OrganizationID += " " }},
	} {
		for _, cached := range []bool{false, true} {
			t.Run(mutation.name+map[bool]string{false: "_database", true: "_cache"}[cached], func(t *testing.T) {
				invalid := activeAgent()
				mutation.mutate(&invalid)
				repo := repositoryFunc(func(context.Context, string) (Agent, error) {
					if cached {
						t.Fatal("DB called after invalid cache hit")
					}
					return invalid, nil
				})
				cache := cacheStub{
					get: func(context.Context, string) (Agent, bool, error) { return invalid, cached, nil },
					set: func(context.Context, string, Agent, time.Duration) error {
						t.Fatal("invalid result cached")
						return nil
					},
				}
				got, err := NewService(repo, cache, time.Minute, nil).Authenticate(context.Background(), "Bearer AGT_test")
				if got != (Agent{}) || err != ErrUnauthorized {
					t.Fatalf("invalid metadata = %#v, %v", got, err)
				}
			})
		}
	}
}

func TestAuthenticateRepositoryFailuresAreUniformAndSanitized(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		dependencyError, want error
	}{
		{"not_found", ErrNotFound, ErrUnauthorized},
		{"wrapped_not_found", errors.Join(errors.New("sensitive-db-error"), ErrNotFound), ErrUnauthorized},
		{"outage", errors.New("sensitive-db-error AGT_test " + testHash), ErrUnavailable},
		{"deadline", context.DeadlineExceeded, ErrUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			repo := repositoryFunc(func(context.Context, string) (Agent, error) { return activeAgent(), tc.dependencyError })
			got, err := NewService(repo, nil, time.Minute, slog.New(slog.NewTextHandler(&logs, nil))).Authenticate(context.Background(), "Bearer AGT_test")
			if err != tc.want || got != (Agent{}) {
				t.Fatalf("failure = %#v, %v; want %v", got, err, tc.want)
			}
			if strings.Contains(logs.String(), "sensitive-db-error") || strings.Contains(logs.String(), "AGT_test") || strings.Contains(logs.String(), testHash) {
				t.Fatal("dependency secrets leaked")
			}
		})
	}
}

func TestAuthenticateCacheErrorsFallBackAndLogOnlySanitizedWarnings(t *testing.T) {
	for _, op := range []string{"get", "set", "both"} {
		t.Run(op, func(t *testing.T) {
			var logs bytes.Buffer
			want := activeAgent()
			sensitive := errors.New("redis-error AGT_test " + testHash)
			cache := cacheStub{
				get: func(context.Context, string) (Agent, bool, error) {
					if op != "set" {
						return want, true, sensitive
					}
					return Agent{}, false, nil
				},
				set: func(context.Context, string, Agent, time.Duration) error {
					if op != "get" {
						return sensitive
					}
					return nil
				},
			}
			dbCalls := 0
			repo := repositoryFunc(func(ctx context.Context, hash string) (Agent, error) { dbCalls++; return want, nil })
			got, err := NewService(repo, cache, time.Minute, slog.New(slog.NewTextHandler(&logs, nil))).Authenticate(context.Background(), "Bearer AGT_test")
			if got != want || err != nil || dbCalls != 1 {
				t.Fatalf("cache outage auth = %#v, %v; DB calls=%d", got, err, dbCalls)
			}
			if !strings.Contains(logs.String(), "level=WARN") {
				t.Fatal("cache error lacked warning")
			}
			for _, secret := range []string{"redis-error", "AGT_test", testHash} {
				if strings.Contains(logs.String(), secret) {
					t.Fatal("cache warning leaked dependency data")
				}
			}
		})
	}
}

func TestAuthenticateInvalidHeaderDoesNotCallDependencies(t *testing.T) {
	repo := repositoryFunc(func(context.Context, string) (Agent, error) {
		t.Fatal("invalid header reached DB")
		return Agent{}, nil
	})
	cache := cacheStub{
		get: func(context.Context, string) (Agent, bool, error) {
			t.Fatal("invalid header reached cache")
			return Agent{}, false, nil
		},
		set: func(context.Context, string, Agent, time.Duration) error {
			t.Fatal("invalid header reached cache")
			return nil
		},
	}
	got, err := NewService(repo, cache, time.Minute, nil).Authenticate(context.Background(), "Bearer AGT_test ")
	if got != (Agent{}) || err != ErrUnauthorized {
		t.Fatalf("invalid header = %#v, %v", got, err)
	}
}

func TestAuthenticatePreservesShorterCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	deadline, _ := ctx.Deadline()
	repo := repositoryFunc(func(ctx context.Context, hash string) (Agent, error) {
		got, ok := ctx.Deadline()
		if !ok || !got.Equal(deadline) {
			t.Fatal("DB deadline extended past caller deadline")
		}
		return activeAgent(), nil
	})
	cache := cacheStub{
		get: func(ctx context.Context, hash string) (Agent, bool, error) {
			got, ok := ctx.Deadline()
			if !ok || !got.Equal(deadline) {
				t.Fatal("cache deadline extended")
			}
			return Agent{}, false, nil
		},
		set: func(ctx context.Context, hash string, a Agent, ttl time.Duration) error {
			got, ok := ctx.Deadline()
			if !ok || !got.Equal(deadline) {
				t.Fatal("cache write deadline extended")
			}
			return nil
		},
	}
	if _, err := NewService(repo, cache, time.Minute, nil).Authenticate(ctx, "Bearer AGT_test"); err != nil {
		t.Fatal(err)
	}
}
