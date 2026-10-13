package smoke

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/config"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
)

// Isolate dotenv and all inputs; none-mode fixtures deliberately retain stale credentials.
func smokeConfig(t *testing.T, values map[string]string) config.Smoke {
	t.Helper()
	t.Chdir(t.TempDir())
	for _, key := range []string{"METRICS_WRITE_AUTH_MODE", "METRICS_QUERY_AUTH_MODE", "METRICS_WRITE_URL", "METRICS_QUERY_URL", "METRICS_USERNAME", "METRICS_WRITE_TOKEN", "METRICS_QUERY_TOKEN", "REMOTE_WRITE_TIMEOUT_SECONDS"} {
		t.Setenv(key, "")
	}
	for key, value := range values {
		t.Setenv(key, value)
	}
	cfg, err := config.LoadSmoke()
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func assertSmokeAuth(t *testing.T, r *http.Request, mode, token string) {
	t.Helper()
	switch mode {
	case "none":
		if len(r.Header.Values("Authorization")) != 0 {
			t.Error("none sent Authorization")
		}
	case "basic":
		user, password, ok := r.BasicAuth()
		if !ok || user != "synthetic-user" || password != token {
			t.Error("Basic auth did not use the direction-specific credentials")
		}
	case "bearer":
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("Bearer auth did not use the direction-specific token")
		}
	}
	for key := range r.Header {
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, "x-amz-") || strings.HasPrefix(lower, "x-amzn-") {
			t.Error("smoke must not discover or sign AWS credentials")
		}
	}
}

func writtenSample(t *testing.T, r *http.Request) (string, int64) {
	t.Helper()
	if r.Method != http.MethodPost || r.Header.Get("X-Prometheus-Remote-Write-Version") != "0.1.0" || r.Header.Get("User-Agent") != "opsgrid-ingest/1" {
		t.Error("Remote Write wire contract changed")
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		t.Error(err)
		return "", 0
	}
	wr, err := remotewrite.Decode(body, 4096)
	if err != nil || len(wr.Timeseries) != 1 || len(wr.Timeseries[0].Samples) != 1 {
		t.Error("bad smoke wire payload")
		return "", 0
	}
	series := wr.Timeseries[0]
	labels := map[string]string{}
	for _, label := range series.Labels {
		labels[label.Name] = label.Value
	}
	if len(labels) != 3 || labels["__name__"] != "opsgrid_step6_smoke_test" || labels["source"] != "metrics-smoke" || len(labels["smoke_id"]) != 24 || series.Samples[0].Value != 1 || series.Samples[0].Timestamp <= 0 {
		t.Error("wrong smoke labels, identifier or sample")
	}
	return labels["smoke_id"], series.Samples[0].Timestamp
}

func querySample(t *testing.T, w http.ResponseWriter, r *http.Request, id string, stamp int64) {
	t.Helper()
	if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || r.URL.RawQuery != "" {
		t.Error("query must be POST form, not URL query parameters")
	}
	if err := r.ParseForm(); err != nil {
		t.Error(err)
	}
	if len(r.PostForm) != 1 || r.PostForm.Get("query") != `opsgrid_step6_smoke_test{source="metrics-smoke",smoke_id="`+id+`"}` || id == "" {
		t.Error("query not scoped to exact written run")
	}
	_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"opsgrid_step6_smoke_test","source":"metrics-smoke","smoke_id":"%s"},"value":[%.3f,"1"]}]}}`, id, float64(stamp)/1000)
}

// Detects mode coupling/token fallback, changed endpoints and false query passes.
func TestSmokeIndependentAuthModes(t *testing.T) {
	for _, writeMode := range []string{"none", "basic", "bearer"} {
		for _, queryMode := range []string{"none", "basic", "bearer"} {
			t.Run(writeMode+"/"+queryMode, func(t *testing.T) {
				queryBase, queryPath := "/api/prom", "/api/prom/api/v1/query"
				if queryMode == "basic" {
					queryBase, queryPath = "/tenant%2Fspace/api/v1/query", "/tenant%2Fspace/api/v1/query"
				} else if queryMode == "bearer" {
					queryBase, queryPath = "/exact/api/v1/query/", "/exact/api/v1/query/"
				}
				var writes, queries atomic.Int32
				var sampleMu sync.Mutex
				var id string
				var stamp int64
				up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					sampleMu.Lock()
					defer sampleMu.Unlock()
					if r.URL.Path == "/write" {
						writes.Add(1)
						if r.URL.RawQuery != "route=synthetic" {
							t.Error("exact write URL was rewritten")
						}
						assertSmokeAuth(t, r, writeMode, "synthetic-write")
						id, stamp = writtenSample(t, r)
						w.WriteHeader(http.StatusNoContent)
						return
					}
					queries.Add(1)
					if r.URL.EscapedPath() != queryPath {
						t.Error("query prefix, escaped path or exact endpoint changed")
					}
					assertSmokeAuth(t, r, queryMode, "synthetic-query")
					querySample(t, w, r, id, stamp)
				}))
				defer up.Close()
				cfg := smokeConfig(t, map[string]string{
					"METRICS_WRITE_AUTH_MODE": "  " + strings.ToUpper(writeMode) + "  ", "METRICS_QUERY_AUTH_MODE": "  " + strings.ToUpper(queryMode) + "  ",
					"METRICS_WRITE_URL": up.URL + "/write?route=synthetic", "METRICS_QUERY_URL": up.URL + queryBase,
					"METRICS_USERNAME": "synthetic-user", "METRICS_WRITE_TOKEN": "synthetic-write", "METRICS_QUERY_TOKEN": "synthetic-query",
				})
				result := Run(context.Background(), cfg)
				if !result.WritePass || result.WriteStatus != 204 || result.QueryState != "PASS" || result.QueryStatus != 200 || result.Reason != "" || writes.Load() != 1 || queries.Load() != 1 {
					t.Fatalf("unexpected result/counts: %+v, writes=%d queries=%d", result, writes.Load(), queries.Load())
				}
			})
		}
	}
}

// AMP-shaped loopback endpoints stay unsigned even with stale AWS/environment credentials.
func TestSmokeAMPUnsignedRequests(t *testing.T) {
	for _, rejectWrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("rejectWrite=%t", rejectWrite), func(t *testing.T) {
			t.Setenv("AWS_ACCESS_KEY_ID", "synthetic-aws-access")
			t.Setenv("AWS_SECRET_ACCESS_KEY", "synthetic-aws-secret")
			t.Setenv("AWS_SESSION_TOKEN", "synthetic-aws-session")
			var writes, queries atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assertSmokeAuth(t, r, "none", "")
				switch r.URL.Path {
				case "/workspaces/synthetic/api/v1/remote_write":
					writes.Add(1)
					writtenSample(t, r)
					if rejectWrite {
						w.WriteHeader(http.StatusForbidden)
					} else {
						w.WriteHeader(http.StatusNoContent)
					}
				case "/workspaces/synthetic/api/v1/query":
					queries.Add(1)
					w.WriteHeader(http.StatusForbidden)
				default:
					t.Error("unexpected AMP-shaped endpoint")
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer up.Close()
			cfg := smokeConfig(t, map[string]string{
				"METRICS_WRITE_AUTH_MODE": "none", "METRICS_QUERY_AUTH_MODE": "none", "METRICS_WRITE_URL": up.URL + "/workspaces/synthetic/api/v1/remote_write", "METRICS_QUERY_URL": up.URL + "/workspaces/synthetic",
				"METRICS_USERNAME": "ignored:stale\nusername", "METRICS_WRITE_TOKEN": "ignored stale\nwrite", "METRICS_QUERY_TOKEN": "ignored stale\nquery",
			})
			result := Run(context.Background(), cfg)
			if writes.Load() != 1 {
				t.Fatal("expected one unsigned write")
			}
			if rejectWrite {
				if result.WritePass || result.WriteStatus != 403 || result.QueryState != "NOT VERIFIED" || queries.Load() != 0 {
					t.Fatalf("unexpected rejected write: %+v", result)
				}
			} else if !result.WritePass || result.QueryState != "FAIL" || result.QueryStatus != 403 || queries.Load() != 1 {
				t.Fatalf("unexpected unsigned query rejection: %+v", result)
			}
		})
	}
}

func TestSmokeWriteNoQuery(t *testing.T) {
	var writes, queries atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/write" {
			queries.Add(1)
			t.Error("legacy partial query must not send a query")
			return
		}
		writes.Add(1)
		assertSmokeAuth(t, r, "basic", "synthetic-write")
		writtenSample(t, r)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer up.Close()
	cfg := smokeConfig(t, map[string]string{"METRICS_WRITE_URL": up.URL + "/write", "METRICS_QUERY_URL": up.URL + "/query", "METRICS_USERNAME": "synthetic-user", "METRICS_WRITE_TOKEN": "synthetic-write"})
	result := Run(context.Background(), cfg)
	if !result.WritePass || result.WriteStatus != 204 || result.QueryState != "NOT VERIFIED" || cfg.Query != nil || cfg.QueryError != nil || writes.Load() != 1 || queries.Load() != 0 {
		t.Fatalf("unexpected legacy partial query result: %+v", result)
	}
}

// Query configuration failure must not suppress an otherwise valid write or send a query.
func TestSmokeExplicitQueryErrorAfterWrite(t *testing.T) {
	for _, tc := range []struct{ name, mode, token string }{
		{"unsupported-mode", "synthetic-private-invalid", "synthetic-query"},
		{"missing-bearer-token", "bearer", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var writes, queries atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/write" {
					writes.Add(1)
					writtenSample(t, r)
					w.WriteHeader(http.StatusNoContent)
					return
				}
				queries.Add(1)
				w.WriteHeader(http.StatusInternalServerError)
			}))
			defer up.Close()
			cfg := smokeConfig(t, map[string]string{"METRICS_WRITE_AUTH_MODE": "none", "METRICS_QUERY_AUTH_MODE": tc.mode, "METRICS_WRITE_URL": up.URL + "/write", "METRICS_QUERY_URL": up.URL + "/query", "METRICS_QUERY_TOKEN": tc.token})
			if cfg.QueryError == nil {
				t.Fatal("fixture must select explicit query error")
			}
			result := Run(context.Background(), cfg)
			if !result.WritePass || result.WriteStatus != 204 || result.QueryState != "FAIL" || result.QueryStatus != 0 || result.Reason != "invalid explicit METRICS_QUERY_* configuration" || writes.Load() != 1 || queries.Load() != 0 {
				t.Fatalf("unexpected explicit query error result: %+v", result)
			}
		})
	}
}

func TestSmokeUpstreamRejectIsFailure(t *testing.T) {
	var writes, queries atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/write" {
			queries.Add(1)
			return
		}
		writes.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("synthetic-private-upstream-body"))
	}))
	defer up.Close()
	cfg := smokeConfig(t, map[string]string{"METRICS_WRITE_AUTH_MODE": "none", "METRICS_QUERY_AUTH_MODE": "none", "METRICS_WRITE_URL": up.URL + "/write", "METRICS_QUERY_URL": up.URL})
	result := Run(context.Background(), cfg)
	if result.WritePass || result.WriteStatus != 401 || result.QueryState != "NOT VERIFIED" || result.Reason != "metrics backend rejected smoke write" || writes.Load() != 1 || queries.Load() != 0 {
		t.Fatalf("unsafe/false write PASS: %+v", result)
	}
}

func TestSmokeQueryFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body, reason string
		status             int
	}{
		{"rejected", "synthetic-private-body", "query API rejected request or response was invalid", 403},
		{"malformed", "synthetic-private-invalid-json", "query API returned invalid Prometheus response", 200},
		{"oversize", strings.Repeat("x", (1<<20)+1), "query API rejected request or response was invalid", 200},
		{"prometheus-error", `{"status":"error","error":"synthetic-private-error"}`, "query API returned invalid Prometheus response", 200},
		{"transport", "", "query transport failed (DNS/TLS/network/timeout)", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var writes, queries atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/write" {
					writes.Add(1)
					w.WriteHeader(http.StatusNoContent)
					return
				}
				queries.Add(1)
				if tc.status == 0 {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = conn.Close()
					return
				}
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer up.Close()
			cfg := smokeConfig(t, map[string]string{"METRICS_WRITE_AUTH_MODE": "none", "METRICS_QUERY_AUTH_MODE": "none", "METRICS_WRITE_URL": up.URL + "/write", "METRICS_QUERY_URL": up.URL})
			result := Run(context.Background(), cfg)
			if !result.WritePass || result.QueryState != "FAIL" || result.QueryStatus != tc.status || result.Reason != tc.reason || writes.Load() != 1 || queries.Load() != 1 {
				t.Fatalf("unexpected query failure: %+v", result)
			}
		})
	}
}

func TestSmokeWriteTransportFailure(t *testing.T) {
	var writes, queries atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/write" {
			queries.Add(1)
			return
		}
		writes.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Error(err)
			return
		}
		_ = conn.Close()
	}))
	defer up.Close()
	cfg := smokeConfig(t, map[string]string{"METRICS_WRITE_AUTH_MODE": "none", "METRICS_QUERY_AUTH_MODE": "none", "METRICS_WRITE_URL": up.URL + "/write", "METRICS_QUERY_URL": up.URL})
	result := Run(context.Background(), cfg)
	if result.WritePass || result.WriteStatus != 0 || result.QueryState != "NOT VERIFIED" || result.Reason != "Remote Write transport failed (DNS/TLS/network/timeout)" || writes.Load() != 1 || queries.Load() != 0 {
		t.Fatalf("unexpected transport result: %+v", result)
	}
}

// Parent cancellation bounds the fixture without changing the production 30s/5s policy.
func TestSmokeStaleSampleCancellation(t *testing.T) {
	var writes, queries atomic.Int32
	var sampleMu sync.Mutex
	var id string
	var stamp int64
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sampleMu.Lock()
		defer sampleMu.Unlock()
		if r.URL.Path == "/write" {
			writes.Add(1)
			id, stamp = writtenSample(t, r)
			w.WriteHeader(http.StatusNoContent)
			return
		}
		queries.Add(1)
		querySample(t, w, r, id, stamp-2000)
	}))
	defer up.Close()
	cfg := smokeConfig(t, map[string]string{"METRICS_WRITE_AUTH_MODE": "none", "METRICS_QUERY_AUTH_MODE": "none", "METRICS_WRITE_URL": up.URL + "/write", "METRICS_QUERY_URL": up.URL})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := Run(ctx, cfg)
	if !result.WritePass || result.QueryState != "FAIL" || result.QueryStatus != 200 || result.Reason != "smoke sample not visible within bounded query-back window" || writes.Load() != 1 || queries.Load() != 1 {
		t.Fatalf("stale sample passed or retried before 5s poll: %+v", result)
	}
}

func TestQueryDoesNotAcceptStaleOrWrongSample(t *testing.T) {
	for _, tc := range []struct {
		name, metric, source, id, value string
		stamp                           float64
	}{
		{"stale", "opsgrid_step6_smoke_test", "metrics-smoke", "run", "1", 1},
		{"wrong-metric", "other", "metrics-smoke", "run", "1", 100},
		{"wrong-source", "opsgrid_step6_smoke_test", "other", "run", "1", 100},
		{"wrong-id", "opsgrid_step6_smoke_test", "metrics-smoke", "other", "1", 100},
		{"wrong-value", "opsgrid_step6_smoke_test", "metrics-smoke", "run", "2", 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"%s","source":"%s","smoke_id":"%s"},"value":[%f,"%s"]}]}}`, tc.metric, tc.source, tc.id, tc.stamp, tc.value)
			if hasSample([]byte(body), "run", 100000) {
				t.Fatal("stale or wrong sample accepted")
			}
		})
	}
}
