package main

import (
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
)

// Every caller is serial: cwd, environment and stdout are process-global.
func isolateCLI(t *testing.T) {
	t.Helper()
	t.Chdir(t.TempDir())
	for _, key := range []string{"METRICS_WRITE_AUTH_MODE", "METRICS_QUERY_AUTH_MODE", "METRICS_WRITE_URL", "METRICS_USERNAME", "METRICS_WRITE_TOKEN", "METRICS_QUERY_URL", "METRICS_QUERY_TOKEN", "REMOTE_WRITE_TIMEOUT_SECONDS", "METRICS_WRITE_USERNAME", "METRICS_WRITE_PASSWORD", "METRICS_QUERY_USERNAME", "METRICS_QUERY_PASSWORD"} {
		t.Setenv(key, "")
	}
}

func captureRun(t *testing.T) (int, string) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = writer
	t.Cleanup(func() {
		os.Stdout = original
		_ = writer.Close()
		_ = reader.Close()
	})
	code := run()
	os.Stdout = original
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return code, string(output)
}

func assertPrivateOutput(t *testing.T, text string, urls ...string) {
	t.Helper()
	forbidden := []string{"synthetic-private", "synthetic-invalid-mode", "Grafana Cloud", "METRICS_WRITE_USERNAME", "METRICS_WRITE_PASSWORD", "METRICS_QUERY_USERNAME", "METRICS_QUERY_PASSWORD", "Bearer synthetic", base64.StdEncoding.EncodeToString([]byte("synthetic-private-user:synthetic-private-write")), base64.StdEncoding.EncodeToString([]byte("synthetic-private-user:synthetic-private-query"))}
	forbidden = append(forbidden, urls...)
	for _, value := range forbidden {
		if value != "" && strings.Contains(text, value) {
			t.Error("diagnostics exposed credentials, raw upstream/mode input, URL or obsolete provider wording")
		}
	}
}

// Missing URL stops before networking; absent modes default safely to Basic.
func TestRunReportsCanonicalPresenceWithoutValues(t *testing.T) {
	isolateCLI(t)
	t.Setenv("METRICS_USERNAME", "synthetic-private-user")
	t.Setenv("METRICS_WRITE_TOKEN", "synthetic-private-write")
	t.Setenv("METRICS_QUERY_TOKEN", "synthetic-private-query")
	code, text := captureRun(t)
	if code != 1 {
		t.Fatal("missing write URL must stop before sending requests")
	}
	for _, line := range []string{"METRICS_WRITE_URL: MISSING", "METRICS_USERNAME: PRESENT", "METRICS_WRITE_TOKEN: PRESENT", "METRICS_QUERY_URL: MISSING", "METRICS_QUERY_TOKEN: PRESENT", "METRICS_WRITE_AUTH_MODE: basic", "METRICS_QUERY_AUTH_MODE: basic"} {
		if !strings.Contains(text, line+"\n") {
			t.Fatalf("missing canonical diagnostic: %s", line)
		}
	}
	assertPrivateOutput(t, text)
}

func assertCLIAuth(t *testing.T, r *http.Request, mode, token string) {
	t.Helper()
	switch mode {
	case "none":
		if len(r.Header.Values("Authorization")) != 0 {
			t.Error("none mode sent Authorization")
		}
	case "basic":
		user, password, ok := r.BasicAuth()
		if !ok || user != "synthetic-private-user" || password != token {
			t.Error("Basic auth used wrong direction credentials")
		}
	case "bearer":
		if r.Header.Get("Authorization") != "Bearer "+token {
			t.Error("Bearer auth used wrong direction token")
		}
	default:
		t.Error("invalid mode must not send a request")
	}
	for key := range r.Header {
		key = strings.ToLower(key)
		if strings.HasPrefix(key, "x-amz-") || strings.HasPrefix(key, "x-amzn-") {
			t.Error("CLI emitted an AWS header")
		}
	}
}

// Detects unsafe mode echoing, provider coupling, incorrect exit states and query-before-write.
func TestRunBackendNeutralModesAndExit(t *testing.T) {
	for _, tc := range []struct {
		name, writeMode, queryMode, writeDiagnostic, queryDiagnostic string
		omitQuery, missingQueryToken, writeTransport, queryTransport bool
		writeStatus, queryStatus                                     int
		queryBody                                                    string
		wantCode, wantWrites, wantQueries                            int
		wantWrite, wantQuery                                         string
	}{
		{name: "normalized-basic", writeMode: " BASIC ", queryMode: " Basic ", writeDiagnostic: "basic", queryDiagnostic: "basic", wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "PASS"},
		{name: "normalized-none-stale-credentials", writeMode: " NONE ", queryMode: " NONE ", writeDiagnostic: "none", queryDiagnostic: "none", wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "PASS"},
		{name: "normalized-bearer", writeMode: " BEARER ", queryMode: " Bearer ", writeDiagnostic: "bearer", queryDiagnostic: "bearer", wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "PASS"},
		{name: "default-basic", writeDiagnostic: "basic", queryDiagnostic: "basic", wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "PASS"},
		{name: "blank-default-basic", writeMode: " \t ", queryMode: " \t ", writeDiagnostic: "basic", queryDiagnostic: "basic", wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "PASS"},
		{name: "absent-legacy-query", omitQuery: true, writeDiagnostic: "basic", queryDiagnostic: "basic", wantWrites: 1, wantWrite: "PASS", wantQuery: "NOT VERIFIED"},
		{name: "partial-legacy-query", missingQueryToken: true, writeDiagnostic: "basic", queryDiagnostic: "basic", wantWrites: 1, wantWrite: "PASS", wantQuery: "NOT VERIFIED"},
		{name: "invalid-write-mode", writeMode: "synthetic-invalid-mode\nsynthetic-private", writeDiagnostic: "INVALID", queryDiagnostic: "basic", wantCode: 1},
		{name: "invalid-query-mode-after-write", queryMode: "synthetic-invalid-mode\nsynthetic-private", writeDiagnostic: "basic", queryDiagnostic: "INVALID", wantCode: 1, wantWrites: 1, wantWrite: "PASS", wantQuery: "FAIL"},
		{name: "explicit-missing-query-token", queryMode: "bearer", missingQueryToken: true, writeDiagnostic: "basic", queryDiagnostic: "bearer", wantCode: 1, wantWrites: 1, wantWrite: "PASS", wantQuery: "FAIL"},
		{name: "explicit-missing-query-url", queryMode: "none", omitQuery: true, writeDiagnostic: "basic", queryDiagnostic: "none", wantCode: 1, wantWrites: 1, wantWrite: "PASS", wantQuery: "FAIL"},
		{name: "rejected-write", writeStatus: 401, writeDiagnostic: "basic", queryDiagnostic: "basic", wantCode: 1, wantWrites: 1, wantWrite: "FAIL", wantQuery: "NOT VERIFIED"},
		{name: "rejected-query", queryStatus: 403, writeDiagnostic: "basic", queryDiagnostic: "basic", wantCode: 1, wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "FAIL"},
		{name: "malformed-query", queryBody: "synthetic-private-invalid-json", writeDiagnostic: "basic", queryDiagnostic: "basic", wantCode: 1, wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "FAIL"},
		{name: "oversize-query", queryBody: strings.Repeat("x", (1<<20)+1), writeDiagnostic: "basic", queryDiagnostic: "basic", wantCode: 1, wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "FAIL"},
		{name: "write-transport", writeTransport: true, writeDiagnostic: "basic", queryDiagnostic: "basic", wantCode: 1, wantWrites: 1, wantWrite: "FAIL", wantQuery: "NOT VERIFIED"},
		{name: "query-transport", queryTransport: true, writeDiagnostic: "basic", queryDiagnostic: "basic", wantCode: 1, wantWrites: 1, wantQueries: 1, wantWrite: "PASS", wantQuery: "FAIL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolateCLI(t)
			var writes, queries atomic.Int32
			var sampleMu sync.Mutex
			var id string
			var stamp int64
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				sampleMu.Lock()
				defer sampleMu.Unlock()
				write := r.URL.Path == "/write"
				if write {
					writes.Add(1)
					assertCLIAuth(t, r, tc.writeDiagnostic, "synthetic-private-write")
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Error(err)
						return
					}
					wr, err := remotewrite.Decode(body, 4096)
					if err != nil || len(wr.Timeseries) != 1 || len(wr.Timeseries[0].Samples) != 1 {
						t.Error("invalid written smoke sample")
						return
					}
					stamp = wr.Timeseries[0].Samples[0].Timestamp
					for _, label := range wr.Timeseries[0].Labels {
						if label.Name == "smoke_id" {
							id = label.Value
						}
					}
				} else {
					queries.Add(1)
					assertCLIAuth(t, r, tc.queryDiagnostic, "synthetic-private-query")
					if writes.Load() != 1 || r.URL.Path != "/prefix/api/v1/query" || r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
						t.Error("query must follow exactly one write using retained prefix/POST form")
					}
					if err := r.ParseForm(); err != nil {
						t.Error(err)
					}
					if r.PostForm.Get("query") != `opsgrid_step6_smoke_test{source="metrics-smoke",smoke_id="`+id+`"}` || id == "" {
						t.Error("query did not select exact run")
					}
				}
				if (write && tc.writeTransport) || (!write && tc.queryTransport) {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					_ = conn.Close()
					return
				}
				if write {
					status := tc.writeStatus
					if status == 0 {
						status = http.StatusNoContent
					}
					w.WriteHeader(status)
					if status != http.StatusNoContent {
						_, _ = io.WriteString(w, "synthetic-private-upstream-write")
					}
					return
				}
				status := tc.queryStatus
				if status == 0 {
					status = http.StatusOK
				}
				w.WriteHeader(status)
				if status != http.StatusOK {
					_, _ = io.WriteString(w, "synthetic-private-upstream-query")
				} else if tc.queryBody != "" {
					_, _ = io.WriteString(w, tc.queryBody)
				} else {
					_, _ = fmt.Fprintf(w, `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"opsgrid_step6_smoke_test","source":"metrics-smoke","smoke_id":"%s"},"value":[%.3f,"1"]}]}}`, id, float64(stamp)/1000)
				}
			}))
			defer up.Close()
			writeURL, queryURL := up.URL+"/write", up.URL+"/prefix"
			t.Setenv("METRICS_WRITE_AUTH_MODE", tc.writeMode)
			t.Setenv("METRICS_QUERY_AUTH_MODE", tc.queryMode)
			t.Setenv("METRICS_WRITE_URL", writeURL)
			if !tc.omitQuery {
				t.Setenv("METRICS_QUERY_URL", queryURL)
			}
			t.Setenv("METRICS_USERNAME", "synthetic-private-user")
			t.Setenv("METRICS_WRITE_TOKEN", "synthetic-private-write")
			if !tc.missingQueryToken {
				t.Setenv("METRICS_QUERY_TOKEN", "synthetic-private-query")
			}
			code, text := captureRun(t)
			if code != tc.wantCode || int(writes.Load()) != tc.wantWrites || int(queries.Load()) != tc.wantQueries {
				t.Fatalf("unexpected exit/counts: code=%d writes=%d queries=%d", code, writes.Load(), queries.Load())
			}
			for _, line := range []string{"METRICS_WRITE_AUTH_MODE: " + tc.writeDiagnostic, "METRICS_QUERY_AUTH_MODE: " + tc.queryDiagnostic, "METRICS_WRITE_URL: PRESENT", "METRICS_USERNAME: PRESENT", "METRICS_WRITE_TOKEN: PRESENT"} {
				if strings.Count(text, line+"\n") != 1 {
					t.Errorf("missing/duplicate safe canonical diagnostic: %s", line)
				}
			}
			queryURLState, queryTokenState := "PRESENT", "PRESENT"
			if tc.omitQuery {
				queryURLState = "MISSING"
			}
			if tc.missingQueryToken {
				queryTokenState = "MISSING"
			}
			for _, line := range []string{"METRICS_QUERY_URL: " + queryURLState, "METRICS_QUERY_TOKEN: " + queryTokenState} {
				if !strings.Contains(text, line+"\n") {
					t.Errorf("missing canonical query presence: %s", line)
				}
			}
			if tc.wantWrite == "" {
				if !strings.Contains(text, "Configuration: FAIL (") || strings.Contains(text, "Metrics Remote Write:") || strings.Contains(text, "Metrics Query-back:") {
					t.Error("invalid write config must stop before smoke")
				}
			} else {
				for _, line := range []string{"Metrics Remote Write: " + tc.wantWrite, "Metrics Query-back: " + tc.wantQuery, "Metric: opsgrid_step6_smoke_test"} {
					if strings.Count(text, line+"\n") != 1 {
						t.Errorf("missing/duplicate backend-neutral outcome: %s", line)
					}
				}
			}
			if tc.writeStatus == 401 && !strings.Contains(text, "Reason: metrics backend rejected smoke write\n") {
				t.Error("write rejection reason must be fixed and provider-neutral")
			}
			assertPrivateOutput(t, text, up.URL, writeURL, queryURL)
		})
	}
}
