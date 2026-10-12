package main

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/config"
	upstreamauth "github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/upstream"
)

// The subprocess executes the real runner AST, replacing only external Docker IO.
func runnerSeam(t *testing.T, scenario string) ([]byte, error) {
	t.Helper()
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell runner behavior test")
	}
	runner, err := filepath.Abs("run.ps1")
	if err != nil {
		t.Fatal(err)
	}
	helper, err := filepath.Abs("runner-behavior.ps1")
	if err != nil {
		t.Fatal(err)
	}
	return exec.Command("powershell.exe", "-NoProfile", "-File", helper, "-Case", scenario, "-Runner", runner).CombinedOutput()
}

func TestRunnerSyntheticEnvironmentLoadsCurrentGateway(t *testing.T) {
	output, err := runnerSeam(t, "environment")
	if err != nil {
		t.Fatalf("environment seam failed: %v", err)
	}
	var env map[string]string
	if err := json.Unmarshal(output, &env); err != nil {
		t.Fatalf("invalid environment seam result: %v", err)
	}
	// No ambient credentials or repository dotenv may satisfy missing runner keys.
	t.Chdir(t.TempDir())
	for _, key := range []string{"METRICS_WRITE_AUTH_MODE", "METRICS_QUERY_AUTH_MODE", "METRICS_USERNAME", "METRICS_WRITE_TOKEN", "METRICS_WRITE_URL", "METRICS_QUERY_URL", "METRICS_QUERY_TOKEN", "DATABASE_URL", "REDIS_URL", "PORT", "LOG_LEVEL", "REMOTE_WRITE_TIMEOUT_SECONDS", "AGENT_AUTH_CACHE_TTL_SECONDS", "REMOTE_WRITE_MAX_BODY_BYTES", "RATE_LIMIT_REQUESTS_PER_SECOND", "RATE_LIMIT_BURST"} {
		t.Setenv(key, "")
	}
	for key, value := range env {
		t.Setenv(key, value)
	}
	gateway, err := config.LoadGateway()
	if err != nil {
		t.Fatalf("runner synthetic environment rejected by current loader: %v", err)
	}
	if gateway.Write.Auth.Mode() != upstreamauth.ModeBasic || gateway.Write.URL != "http://127.0.0.1:19091/api/v1/write" {
		t.Fatal("runner no longer satisfies isolated upstream Basic Auth contract")
	}
	req, err := http.NewRequest(http.MethodPost, "http://127.0.0.1/synthetic", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := gateway.Write.Auth.Apply(req); err != nil {
		t.Fatal("runner authentication cannot be applied")
	}
	username, token, ok := req.BasicAuth()
	if !ok || username != "local-smoke-user" || token != "local-smoke-password" {
		t.Fatal("runner no longer supplies canonical Basic credentials")
	}
	if gateway.MaxBodyBytes != 2048 || gateway.RateRPS != 0.001 || gateway.RateBurst != 20 {
		t.Fatal("runner no longer exercises oversize/backpressure settings")
	}
}

func TestRunnerCleanup(t *testing.T) {
	for _, scenario := range []string{"success", "container-remove", "container-inspect", "container-owner", "unpause", "network-remove", "network-inspect", "network-owner", "temp-path", "temp-unowned"} {
		t.Run(scenario, func(t *testing.T) {
			output, err := runnerSeam(t, scenario)
			var result struct {
				Removed        []string
				Unpaused       []string
				NetworkRemoved bool
				TempRemoved    bool
				Failure        string
			}
			if parseErr := json.Unmarshal(output, &result); parseErr != nil {
				t.Fatalf("invalid cleanup result: %v; output=%s", parseErr, output)
			}
			if scenario == "success" {
				if err != nil || result.Failure != "" {
					t.Fatalf("successful cleanup failed: %v; %s", err, result.Failure)
				}
			} else if err == nil || result.Failure == "" {
				t.Fatalf("cleanup %s must cause a nonzero runner exit", scenario)
			}
			wantRemoved := 4
			if scenario == "container-inspect" || scenario == "container-owner" {
				wantRemoved = 3
				for _, name := range result.Removed {
					if strings.HasSuffix(name, "-gateway") {
						t.Fatal("removed an unverified/unowned container")
					}
				}
			}
			if len(result.Removed) != wantRemoved {
				t.Fatalf("cleanup did not attempt remaining owned containers: got %d, want %d", len(result.Removed), wantRemoved)
			}
			wantNetwork := scenario != "network-inspect" && scenario != "network-owner"
			if result.NetworkRemoved != wantNetwork {
				t.Fatal("network cleanup must require verified ownership")
			}
			if result.TempRemoved != (scenario != "temp-path" && scenario != "temp-unowned") {
				t.Fatal("temp cleanup must remove only its resolved expected path")
			}
			if len(result.Unpaused) != 1 || !strings.HasSuffix(result.Unpaused[0], "-db") {
				t.Fatal("paused fixture unpause was not attempted")
			}
		})
	}
}
