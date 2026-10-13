package config

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	upstreamauth "github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/upstream"
)

// These tests catch missing validation, numeric overflow and accidental smoke dependencies.
func envFixture() map[string]string {
	return map[string]string{
		"DATABASE_URL": "postgres://user:password@localhost/db", "REDIS_URL": "redis://localhost:6379",
		"METRICS_WRITE_URL": "https://metrics.example/api/v1/push", "METRICS_USERNAME": "tenant", "METRICS_WRITE_TOKEN": "private",
	}
}
func getter(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
func TestGatewayDefaults(t *testing.T) {
	c, err := loadGateway(getter(envFixture()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8080 || c.AuthCacheTTL != 60*time.Second || c.Write.Timeout != 10*time.Second || c.MaxBodyBytes != 10485760 || c.RateRPS != 5 || c.RateBurst != 20 {
		t.Fatalf("unexpected defaults: port=%d ttl=%v timeout=%v body=%d rate=%v burst=%d", c.Port, c.AuthCacheTTL, c.Write.Timeout, c.MaxBodyBytes, c.RateRPS, c.RateBurst)
	}
}
func TestRequiredConfigDoesNotLeakValues(t *testing.T) {
	for _, k := range []string{"DATABASE_URL", "REDIS_URL", "METRICS_WRITE_URL", "METRICS_USERNAME", "METRICS_WRITE_TOKEN"} {
		t.Run(k, func(t *testing.T) {
			m := envFixture()
			delete(m, k)
			_, err := loadGateway(getter(m))
			if err == nil || !strings.Contains(err.Error(), k) || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "postgres://") {
				t.Fatalf("unsafe/missing validation: %v", err)
			}
		})
	}
}
func TestRejectInvalidNumbersAndURLs(t *testing.T) {
	cases := map[string][]string{"PORT": {"0", "65536", "abc"}, "AGENT_AUTH_CACHE_TTL_SECONDS": {"0", "-1", "999999999999999999"}, "REMOTE_WRITE_TIMEOUT_SECONDS": {"0", "9223372036854775807"}, "REMOTE_WRITE_MAX_BODY_BYTES": {"0", "9223372036854775807"}, "RATE_LIMIT_REQUESTS_PER_SECOND": {"0", "1e-12", "NaN", "+Inf"}, "RATE_LIMIT_BURST": {"0", "-1"}, "LOG_LEVEL": {"nonsense"}, "METRICS_WRITE_URL": {"ftp://example/path", "https://user:private@example/path", "http://example/path"}, "DATABASE_URL": {"not-a-db-url"}, "REDIS_URL": {"http://example"}}
	for key, values := range cases {
		for _, v := range values {
			t.Run(key+"/"+v, func(t *testing.T) {
				m := envFixture()
				m[key] = v
				if _, err := loadGateway(getter(m)); err == nil {
					t.Fatal("accepted invalid config")
				}
			})
		}
	}
}
func TestSmokeDoesNotRequireDatabaseOrRedis(t *testing.T) {
	m := envFixture()
	delete(m, "DATABASE_URL")
	delete(m, "REDIS_URL")
	c, err := loadSmoke(getter(m))
	if err != nil {
		t.Fatal(err)
	}
	if c.Query != nil {
		t.Fatal("query credentials invented")
	}
	m["METRICS_QUERY_URL"] = "https://metrics.example/api/v1/query"
	c, err = loadSmoke(getter(m))
	if err != nil || c.Query != nil {
		t.Fatal("partial query config must not block write")
	}
	m["METRICS_QUERY_TOKEN"] = "read-private"
	c, err = loadSmoke(getter(m))
	if err != nil || c.Query == nil {
		t.Fatal("explicit complete query config not loaded")
	}
}
func TestGatewayUsesCanonicalCredentials(t *testing.T) {
	m := envFixture()
	m["METRICS_WRITE_USERNAME"] = "legacy-user"
	m["METRICS_WRITE_PASSWORD"] = "legacy-token"
	m["METRICS_QUERY_URL"] = "invalid-optional-query"
	m["METRICS_QUERY_TOKEN"] = "read-private"
	c, err := loadGateway(getter(m))
	if err != nil {
		t.Fatal(err)
	}
	assertUpstreamAuth(t, c.Write, upstreamauth.ModeBasic, "tenant", "private")
}

func TestGatewayDoesNotAcceptLegacyCredentials(t *testing.T) {
	for _, key := range []string{"METRICS_USERNAME", "METRICS_WRITE_TOKEN"} {
		t.Run(key, func(t *testing.T) {
			m := envFixture()
			m["METRICS_WRITE_USERNAME"] = "legacy-user"
			m["METRICS_WRITE_PASSWORD"] = "legacy-token"
			delete(m, key)
			_, err := loadGateway(getter(m))
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Fatal("legacy credentials replaced required canonical config")
			}
		})
	}
}

func TestSharedUsernameRejectsColonWithoutLeaking(t *testing.T) {
	m := envFixture()
	m["METRICS_USERNAME"] = "private:tenant"
	_, err := loadGateway(getter(m))
	if err == nil || !strings.Contains(err.Error(), "METRICS_USERNAME") || strings.Contains(err.Error(), "private") {
		t.Fatalf("unsafe/missing Basic Auth username validation: %v", err)
	}
}

func TestSmokeQueryURLAndSeparateReadToken(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"base", "https://metrics.example/api/prom", "https://metrics.example/api/prom/api/v1/query"},
		{"base trailing slash", "https://metrics.example/api/prom/", "https://metrics.example/api/prom/api/v1/query"},
		{"root", "https://metrics.example", "https://metrics.example/api/v1/query"},
		{"exact endpoint", "https://metrics.example/api/prom/api/v1/query", "https://metrics.example/api/prom/api/v1/query"},
		{"exact trailing slash", "https://metrics.example/api/prom/api/v1/query/", "https://metrics.example/api/prom/api/v1/query/"},
		{"escaped path", "https://metrics.example/tenant%20space/api/prom", "https://metrics.example/tenant%20space/api/prom/api/v1/query"},
		{"escaped separator", "https://metrics.example/tenant%2Fsynthetic/api/prom", "https://metrics.example/tenant%2Fsynthetic/api/prom/api/v1/query"},
		{"AMP prefix", "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-synthetic", "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-synthetic/api/v1/query"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := envFixture()
			m["METRICS_QUERY_URL"] = tc.input
			m["METRICS_QUERY_TOKEN"] = "read-private"
			m["METRICS_QUERY_USERNAME"] = "legacy-reader"
			m["METRICS_QUERY_PASSWORD"] = "legacy-read-token"
			c, err := loadSmoke(getter(m))
			if err != nil || c.QueryError != nil || c.Query == nil {
				t.Fatalf("complete query config not loaded: %v / %v", err, c.QueryError)
			}
			if c.Query.URL != tc.want {
				t.Fatal("query endpoint incorrect")
			}
			assertUpstreamAuth(t, *c.Query, upstreamauth.ModeBasic, "tenant", "read-private")
			assertUpstreamAuth(t, c.Write, upstreamauth.ModeBasic, "tenant", "private")
		})
	}
}

func TestSmokePartialQueryNeverFallsBackToWriteToken(t *testing.T) {
	for _, tc := range []struct{ name, url, token string }{
		{"absent", "", ""},
		{"URL only", "https://metrics.example/api/prom", ""},
		{"blank token", "https://metrics.example/api/prom", "  "},
		{"token only", "", "read-private"},
		{"invalid partial URL", "invalid-url", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := envFixture()
			m["METRICS_QUERY_URL"] = tc.url
			m["METRICS_QUERY_TOKEN"] = tc.token
			m["METRICS_QUERY_USERNAME"] = "legacy-reader"
			m["METRICS_QUERY_PASSWORD"] = "legacy-read-token"
			c, err := loadSmoke(getter(m))
			if err != nil || c.QueryError != nil || c.Query != nil {
				t.Fatal("partial canonical query config must remain unverified without blocking write")
			}
		})
	}
}

func TestSmokeInvalidCompleteQueryDoesNotBlockWriteConfig(t *testing.T) {
	for _, value := range []string{"invalid-private-url", "https://reader:private@metrics.example/api/prom", "http://metrics.example/api/prom", "https://metrics.example/api/prom#private", "https://metrics.example/api/prom?token=private", "https://metrics.example/api/prom?"} {
		m := envFixture()
		m["METRICS_QUERY_URL"] = value
		m["METRICS_QUERY_TOKEN"] = "read-private"
		c, err := loadSmoke(getter(m))
		if err != nil || c.Query != nil || c.QueryError == nil || !strings.Contains(c.QueryError.Error(), "METRICS_QUERY_URL") || strings.Contains(c.QueryError.Error(), "private") {
			t.Fatal("invalid explicit query must report a sanitized query error independently of write")
		}
	}
}

// These cases fail if selection still requires Basic credentials for every mode,
// ignores explicit modes, or validates credentials that the chosen mode discards.
func TestGatewayAuthModes(t *testing.T) {
	for _, tc := range []struct {
		name, mode, username, token, errorKey string
	}{
		{"legacy", "", "tenant", "private", ""},
		{"blank legacy", "  ", "tenant", "private", ""},
		{"normalized basic", " BaSiC ", " tenant ", " private ", ""},
		{"none URL only", "none", "", "", ""},
		{"none ignores stale", "none", "invalid:tenant\n", "invalid\n", ""},
		{"bearer token only", " BeArEr ", "", "write-private", ""},
		{"bearer ignores username", "bearer", "invalid:tenant\n", "write-private", ""},
		{"unknown", "private-mode", "tenant", "private", "METRICS_WRITE_AUTH_MODE"},
		{"basic missing username", "basic", "", "private", "METRICS_USERNAME"},
		{"basic missing token", "basic", "tenant", "", "METRICS_WRITE_TOKEN"},
		{"basic username colon", "basic", "private:tenant", "private", "METRICS_USERNAME"},
		{"basic username control", "basic", "tenant\n", "private", "METRICS_USERNAME"},
		{"basic token control", "basic", "tenant", "private\n", "METRICS_WRITE_TOKEN"},
		{"bearer missing token", "bearer", "tenant", "", "METRICS_WRITE_TOKEN"},
		{"bearer whitespace", "bearer", "tenant", "private token", "METRICS_WRITE_TOKEN"},
		{"bearer non ASCII", "bearer", "tenant", "privaté", "METRICS_WRITE_TOKEN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := envFixture()
			m["METRICS_WRITE_AUTH_MODE"], m["METRICS_USERNAME"], m["METRICS_WRITE_TOKEN"] = tc.mode, tc.username, tc.token
			c, err := loadGateway(getter(m))
			if tc.errorKey == "" {
				if err != nil {
					t.Fatalf("selected mode rejected: %v", err)
				}
				mode := upstreamauth.ModeBasic
				switch strings.ToLower(strings.TrimSpace(tc.mode)) {
				case "none":
					mode = upstreamauth.ModeNone
				case "bearer":
					mode = upstreamauth.ModeBearer
				}
				assertUpstreamAuth(t, c.Write, mode, tc.username, tc.token)
			} else if err == nil || !strings.Contains(err.Error(), tc.errorKey) {
				t.Fatalf("missing canonical mode validation for %s: %v", tc.errorKey, err)
			}
		})
	}
}

func TestGatewayIgnoresQueryModes(t *testing.T) {
	m := envFixture()
	m["METRICS_QUERY_AUTH_MODE"] = "private-unknown-mode"
	m["METRICS_QUERY_URL"] = "https://reader:private@metrics.example/?token=private"
	m["METRICS_QUERY_TOKEN"] = "private\n"
	if _, err := loadGateway(getter(m)); err != nil {
		t.Fatalf("query blocked gateway: %v", err)
	}
}

// Explicit nonblank modes must report incomplete query configuration; absent or
// blank legacy modes must keep partial Basic configuration silently unverified.
func TestSmokeQueryModePresence(t *testing.T) {
	for _, tc := range []struct {
		name, mode, url, username, token, errorKey string
		wantQuery                                  bool
	}{
		{"legacy absent", "", "", "tenant", "", "", false},
		{"legacy URL only", "", "https://metrics.example/api/prom", "tenant", "", "", false},
		{"blank legacy partial invalid", " \t ", "invalid-private-url", "tenant", "", "", false},
		{"legacy no username", "", "https://metrics.example", "", "read-private", "", false},
		{"legacy complete", "", "https://metrics.example", "tenant", "read-private", "", true},
		{"legacy invalid URL", "", "invalid-private-url", "tenant", "read-private", "METRICS_QUERY_URL", false},
		{"legacy invalid credential", "", "https://metrics.example", "tenant\n", "read-private", "METRICS_USERNAME", false},
		{"explicit none", " NoNe ", "https://metrics.example", "", "", "", true},
		{"none ignores stale", "none", "https://metrics.example", "invalid:tenant\n", "invalid\n", "", true},
		{"explicit bearer", " BeArEr ", "https://metrics.example", "", "read-private", "", true},
		{"bearer ignores username", "bearer", "https://metrics.example", "invalid:tenant\n", "read-private", "", true},
		{"explicit basic", "basic", "https://metrics.example", "tenant", "read-private", "", true},
		{"unknown without fields", "private-mode", "", "", "", "METRICS_QUERY_AUTH_MODE", false},
		{"basic missing URL", "basic", "", "tenant", "read-private", "METRICS_QUERY_URL", false},
		{"none missing URL", "none", "", "", "", "METRICS_QUERY_URL", false},
		{"bearer missing URL", "bearer", "", "", "read-private", "METRICS_QUERY_URL", false},
		{"basic missing username", "basic", "https://metrics.example", "", "read-private", "METRICS_USERNAME", false},
		{"basic missing read token", "basic", "https://metrics.example", "tenant", "", "METRICS_QUERY_TOKEN", false},
		{"bearer missing read token", "bearer", "https://metrics.example", "", "", "METRICS_QUERY_TOKEN", false},
		{"bearer bad token", "bearer", "https://metrics.example", "", "read private", "METRICS_QUERY_TOKEN", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := envFixture()
			// A valid write Bearer token cannot supply the independent read token.
			m["METRICS_WRITE_AUTH_MODE"] = "bearer"
			m["METRICS_QUERY_AUTH_MODE"], m["METRICS_QUERY_URL"] = tc.mode, tc.url
			m["METRICS_USERNAME"], m["METRICS_QUERY_TOKEN"] = tc.username, tc.token
			c, err := loadSmoke(getter(m))
			if err != nil {
				t.Fatalf("query blocked valid write: %v", err)
			}
			if (c.Query != nil) != tc.wantQuery {
				t.Fatal("wrong query presence")
			}
			assertUpstreamAuth(t, c.Write, upstreamauth.ModeBearer, "", "private")
			if c.Query != nil {
				mode := upstreamauth.ModeBasic
				switch strings.ToLower(strings.TrimSpace(tc.mode)) {
				case "none":
					mode = upstreamauth.ModeNone
				case "bearer":
					mode = upstreamauth.ModeBearer
				}
				assertUpstreamAuth(t, *c.Query, mode, tc.username, tc.token)
			}
			if tc.errorKey == "" {
				if c.QueryError != nil {
					t.Fatalf("unexpected query error: %v", c.QueryError)
				}
			} else if c.QueryError == nil || !strings.Contains(c.QueryError.Error(), tc.errorKey) || strings.Contains(c.QueryError.Error(), "private") {
				t.Fatalf("missing/unsafe query error: %v", c.QueryError)
			}
		})
	}
}

func TestModeErrorsNeverLeak(t *testing.T) {
	for _, prefix := range []string{"METRICS_WRITE", "METRICS_QUERY"} {
		for _, tc := range []struct{ mode, username, token, key string }{
			{"private-mode", "tenant", "private-token", prefix + "_AUTH_MODE"},
			{"basic", "private:tenant", "private-token", "METRICS_USERNAME"},
			{"basic", "tenant", "private-token\n", prefix + "_TOKEN"},
			{"bearer", "private:tenant", "private token", prefix + "_TOKEN"},
		} {
			t.Run(prefix+"/"+tc.mode+"/"+tc.key, func(t *testing.T) {
				m := envFixture()
				m[prefix+"_URL"] = "https://metrics.example/api/prom"
				m[prefix+"_AUTH_MODE"], m["METRICS_USERNAME"], m[prefix+"_TOKEN"] = tc.mode, tc.username, tc.token
				m["METRICS_WRITE_AUTH_MODE"] = "none"
				if prefix == "METRICS_WRITE" {
					m[prefix+"_AUTH_MODE"] = tc.mode
				}
				_, err := upstream(getter(m), prefix)
				if err == nil || !strings.Contains(err.Error(), tc.key) || strings.Contains(err.Error(), "private") || strings.Contains(err.Error(), "metrics.example") {
					t.Fatalf("unsafe/missing auth error: %v", err)
				}
			})
		}
	}
}

func TestWriteURLRemainsExact(t *testing.T) {
	for _, mode := range []string{"basic", "none", "bearer"} {
		m := envFixture()
		m["METRICS_WRITE_AUTH_MODE"] = mode
		m["METRICS_WRITE_URL"] = "https://metrics.example/tenant%2Fsynthetic/write/?tenant=synthetic"
		c, err := loadGateway(getter(m))
		if err != nil || c.Write.URL != m["METRICS_WRITE_URL"] {
			t.Fatal("write URL rewritten or query string treated as auth")
		}
	}
}

func TestURLPolicyEveryAuthMode(t *testing.T) {
	for _, mode := range []string{"basic", "none", "bearer"} {
		for _, endpoint := range []string{"https://metrics.example/api/prom", "http://localhost/api/prom", "http://127.0.0.1/api/prom", "http://[::1]/api/prom", "http://metrics.example/api/prom", "https://reader:private@metrics.example/api/prom", "https://metrics.example/api/prom#private", "ftp://metrics.example/api/prom", "https://metrics.example/api/prom?", "https://metrics.example/api/prom?tenant=synthetic"} {
			t.Run(mode+"/"+endpoint, func(t *testing.T) {
				m := envFixture()
				m["METRICS_WRITE_AUTH_MODE"], m["METRICS_QUERY_AUTH_MODE"] = mode, mode
				m["METRICS_QUERY_URL"], m["METRICS_QUERY_TOKEN"] = endpoint, "read-private"
				c, err := loadSmoke(getter(m))
				valid := endpoint == "https://metrics.example/api/prom" || endpoint == "http://localhost/api/prom" || endpoint == "http://127.0.0.1/api/prom" || endpoint == "http://[::1]/api/prom"
				if err != nil || (c.Query != nil) != valid || (c.QueryError == nil) != valid {
					t.Fatal("query URL policy changed by auth mode")
				}
				m["METRICS_WRITE_URL"] = endpoint
				_, err = loadGateway(getter(m))
				writeValid := valid || strings.Contains(endpoint, "?")
				if (err == nil) != writeValid {
					t.Fatal("write URL policy changed by auth mode")
				}
			})
		}
	}
}

func assertUpstreamAuth(t *testing.T, c Upstream, mode upstreamauth.Mode, username, token string) {
	t.Helper()
	if c.Auth.Mode() != mode {
		t.Fatal("wrong selected auth mode")
	}
	req, err := http.NewRequest(http.MethodPost, "https://synthetic.example", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "stale")
	if err := c.Auth.Apply(req); err != nil {
		t.Fatalf("cannot apply configured auth: %v", err)
	}
	switch mode {
	case upstreamauth.ModeNone:
		if req.Header.Get("Authorization") != "" {
			t.Fatal("none retained stale credentials")
		}
	case upstreamauth.ModeBasic:
		u, p, ok := req.BasicAuth()
		if !ok || u != username || p != token {
			t.Fatal("Basic credential bytes changed")
		}
	case upstreamauth.ModeBearer:
		if req.Header.Get("Authorization") != "Bearer "+token {
			t.Fatal("wrong independent Bearer token")
		}
	}
}

func TestDotenvEnvironmentWinsAndMissingFileIsOK(t *testing.T) {
	t.Setenv("INGEST_CONFIG_TEST", "production")
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("INGEST_CONFIG_TEST=local\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadDotEnv(path); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("INGEST_CONFIG_TEST") != "production" {
		t.Fatal("dotenv overwrote environment")
	}
	if err := loadDotEnv(filepath.Join(t.TempDir(), "missing")); err != nil {
		t.Fatal(err)
	}
}
func TestDotenvParseErrorIsSanitized(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte("PRIVATE secret-value='broken\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadDotEnv(path); err == nil || strings.Contains(err.Error(), "secret-value") {
		t.Fatalf("unsafe dotenv error: %v", err)
	}
}
