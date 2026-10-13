package e2epayload

import (
	"errors"
	"strings"
	"testing"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
	"github.com/golang/snappy"
	"github.com/prometheus/prometheus/prompb"
)

func options(kind string) Options {
	return Options{Kind: kind, RunID: "run_RW01", TimestampMillis: 1791520000123, MaxBytes: 10485760,
		SpoofOrganizationID: "fake-org", SpoofVMID: "fake-vm", SpoofAgentID: "fake-agent"}
}

func TestBuildWireCases(t *testing.T) {
	for _, kind := range []string{"valid", "spoof", "missing-name", "duplicate-label"} {
		t.Run(kind, func(t *testing.T) {
			body, err := Build(options(kind))
			if err != nil {
				t.Fatal(err)
			}
			raw, err := snappy.Decode(nil, body)
			if err != nil {
				t.Fatal(err)
			}
			var req prompb.WriteRequest
			if err := req.Unmarshal(raw); err != nil {
				t.Fatal(err)
			}
			if len(req.Timeseries) != 1 {
				t.Fatalf("series = %d", len(req.Timeseries))
			}
			ts := req.Timeseries[0]
			if len(ts.Samples) != 1 || ts.Samples[0].Value != 1 || ts.Samples[0].Timestamp != 1791520000123 {
				t.Fatalf("wrong sample: %+v", ts.Samples)
			}
			labels := map[string][]string{}
			for _, l := range ts.Labels {
				labels[l.Name] = append(labels[l.Name], l.Value)
			}
			if len(labels["run_id"]) < 1 || labels["run_id"][0] != "run_RW01" || len(labels["case_id"]) != 1 || labels["case_id"][0] != kind {
				t.Fatalf("wrong marker labels: %+v", labels)
			}
			if kind == "missing-name" {
				if len(labels["__name__"]) != 0 {
					t.Fatal("name unexpectedly present")
				}
			} else if len(labels["__name__"]) != 1 || labels["__name__"][0] != "opsgrid_amp_e2e_probe" {
				t.Fatal("wrong metric name")
			}
			if kind == "duplicate-label" {
				if len(labels["run_id"]) != 2 {
					t.Fatal("missing duplicate")
				}
			} else if len(labels["run_id"]) != 1 {
				t.Fatal("unexpected duplicate")
			}
			for key, want := range map[string]string{"organization_id": "fake-org", "vm_id": "fake-vm", "agent_id": "fake-agent"} {
				if kind == "spoof" {
					if len(labels[key]) != 1 || labels[key][0] != want {
						t.Fatalf("wrong spoof %s", key)
					}
				} else if len(labels[key]) != 0 {
					t.Fatalf("unexpected identity %s", key)
				}
			}
		})
	}
}

func TestBuildCorruptSnappy(t *testing.T) {
	body, err := Build(options("corrupt-snappy"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := snappy.Decode(nil, body); err == nil {
		t.Fatal("corrupt fixture decoded")
	}
}

func TestBuildOversize(t *testing.T) {
	o := options("oversize")
	o.MaxBytes = 1024
	body, err := Build(o)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 1025 {
		t.Fatalf("bytes=%d", len(body))
	}
	if _, err := remotewrite.Decode(body, 1024); !errors.Is(err, remotewrite.ErrTooLarge) {
		t.Fatalf("expected too large: %v", err)
	}
}

func TestBuildRejectsInvalidInput(t *testing.T) {
	for _, mutate := range []func(*Options){
		func(o *Options) { o.Kind = "unknown" }, func(o *Options) { o.RunID = "" },
		func(o *Options) { o.RunID = "bad space" }, func(o *Options) { o.RunID = strings.Repeat("A", 129) },
		func(o *Options) { o.TimestampMillis = 0 }, func(o *Options) { o.TimestampMillis = -1 },
		func(o *Options) { o.MaxBytes = 0 }, func(o *Options) { o.MaxBytes = -1 }, func(o *Options) { o.MaxBytes = 67108865 },
		func(o *Options) { o.Kind = "spoof"; o.SpoofAgentID = "" },
		func(o *Options) { o.Kind = "spoof"; o.SpoofVMID = "" },
		func(o *Options) { o.Kind = "spoof"; o.SpoofOrganizationID = "" },
	} {
		o := options("valid")
		mutate(&o)
		if _, err := Build(o); err == nil {
			t.Fatalf("accepted invalid input %+v", o)
		}
	}
}
