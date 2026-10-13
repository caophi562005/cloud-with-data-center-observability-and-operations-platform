package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
)

func args(output string) []string {
	return []string{"--kind", "valid", "--run-id", "run_CLI01", "--timestamp-ms", "1791520000123", "--max-bytes", "10485760", "--output", output}
}

func TestRunProducesFixture(t *testing.T) {
	output := filepath.Join(t.TempDir(), "fixture.bin")
	var stdout, stderr bytes.Buffer
	if code := run(args(output), &stdout, &stderr); code != 0 {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
	body, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	req, err := remotewrite.Decode(body, 10485760)
	if err != nil {
		t.Fatal(err)
	}
	if len(req.Timeseries) != 1 || req.Timeseries[0].Samples[0].Timestamp != 1791520000123 {
		t.Fatal("wrong wire fixture")
	}
	if !strings.Contains(stdout.String(), "valid") || !strings.Contains(stdout.String(), "bytes=") || stderr.Len() != 0 {
		t.Fatal("unexpected diagnostics")
	}
}

func TestRunDoesNotOverwrite(t *testing.T) {
	output := filepath.Join(t.TempDir(), "fixture.bin")
	if err := os.WriteFile(output, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := run(args(output), &stdout, &stderr); code != 1 {
		t.Fatalf("code=%d", code)
	}
	body, _ := os.ReadFile(output)
	if string(body) != "original" {
		t.Fatal("overwrote existing fixture")
	}
	if stdout.Len() != 0 {
		t.Fatal("reported success")
	}
}

func TestRunRejectsArgumentsWithoutEchoingThem(t *testing.T) {
	for _, input := range [][]string{
		{}, {"--token", "AGT_secret_diagnostic_canary"},
		{"--kind", "valid", "--run-id", "run", "--timestamp-ms", "0", "--output", "private/path"},
		{"--timestamp-ms", "not-a-number-secret"}, {"unexpected-private-argument"},
	} {
		var stdout, stderr bytes.Buffer
		if code := run(input, &stdout, &stderr); code != 1 {
			t.Fatalf("accepted args, code=%d", code)
		}
		if stdout.Len() != 0 || stderr.Len() == 0 {
			t.Fatal("wrong failure diagnostics")
		}
		for _, secret := range []string{"AGT_secret_diagnostic_canary", "not-a-number-secret", "unexpected-private-argument", "private/path"} {
			if strings.Contains(stderr.String(), secret) {
				t.Fatal("echoed argument")
			}
		}
	}
}

func TestRunRejectsUnwritablePathWithoutEchoingIt(t *testing.T) {
	var stdout, stderr bytes.Buffer
	output := filepath.Join(t.TempDir(), "missing", "private-fixture.bin")
	if code := run(args(output), &stdout, &stderr); code != 1 {
		t.Fatalf("code=%d", code)
	}
	if strings.Contains(stderr.String(), output) || strings.Contains(stderr.String(), "private-fixture.bin") {
		t.Fatal("echoed path")
	}
}
