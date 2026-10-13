package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/config"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/smoke"
	upstreamauth "github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/upstream"
)

func main() { os.Exit(run()) }
func run() int {
	if err := config.LoadDotEnv(); err != nil {
		fmt.Println("Configuration: FAIL (cannot load dotenv)")
		return 1
	}
	for _, name := range []string{"METRICS_WRITE_URL", "METRICS_USERNAME", "METRICS_WRITE_TOKEN", "METRICS_QUERY_URL", "METRICS_QUERY_TOKEN"} {
		state := "MISSING"
		if config.Present(name) {
			state = "PRESENT"
		}
		fmt.Printf("%s: %s\n", name, state)
	}
	for _, name := range []string{"METRICS_WRITE_AUTH_MODE", "METRICS_QUERY_AUTH_MODE"} {
		mode, err := upstreamauth.ParseMode(os.Getenv(name))
		diagnostic := "INVALID"
		if err == nil {
			diagnostic = string(mode)
		}
		fmt.Printf("%s: %s\n", name, diagnostic)
	}
	cfg, err := config.LoadSmoke()
	if err != nil {
		fmt.Printf("Configuration: FAIL (%s)\n", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result := smoke.Run(ctx, cfg)
	state := "FAIL"
	if result.WritePass {
		state = "PASS"
	}
	fmt.Printf("Metrics Remote Write: %s\n", state)
	if result.WriteStatus != 0 {
		fmt.Printf("HTTP result: %d\n", result.WriteStatus)
	} else {
		fmt.Println("HTTP result: NO RESPONSE")
	}
	fmt.Printf("Metrics Query-back: %s\n", result.QueryState)
	if result.QueryStatus != 0 {
		fmt.Printf("Query HTTP result: %d\n", result.QueryStatus)
	}
	fmt.Printf("Metric: %s\n", smoke.Metric)
	if result.Reason != "" {
		fmt.Printf("Reason: %s\n", result.Reason)
	}
	if !result.WritePass || result.QueryState == "FAIL" {
		return 1
	}
	return 0
}
