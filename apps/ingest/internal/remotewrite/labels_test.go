package remotewrite

import (
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/prometheus/prometheus/prompb"
	"testing"
)

var trusted = auth.Agent{AgentID: "agent-trusted", VMID: "vm-trusted", OrganizationID: "org-trusted", Status: "ACTIVE"}

// Detects spoofed/duplicated identity, loss of metric names and unsorted forwarded labels.
func TestTrustedLabelsOverwriteAndSort(t *testing.T) {
	r := sampleRequest()
	r.Timeseries[0].Labels = append(r.Timeseries[0].Labels, prompb.Label{Name: "vm_id", Value: "fake"}, prompb.Label{Name: "agent_id", Value: "fake"}, prompb.Label{Name: "agent_id", Value: "second-fake"}, prompb.Label{Name: "organization_id", Value: "fake"})
	if err := InjectLabels(r, trusted); err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	previous := ""
	for _, l := range r.Timeseries[0].Labels {
		if l.Name <= previous {
			t.Fatal("not strictly sorted/duplicate")
		}
		previous = l.Name
		seen[l.Name] = l.Value
	}
	for k, v := range map[string]string{"__name__": "test_metric", "job": "node", "agent_id": "agent-trusted", "vm_id": "vm-trusted", "organization_id": "org-trusted"} {
		if seen[k] != v {
			t.Fatalf("%s not preserved/trusted", k)
		}
	}
}
func TestLabelsRejectMalformedSeries(t *testing.T) {
	cases := []prompb.TimeSeries{
		{Samples: []prompb.Sample{{Value: 1, Timestamp: 1}}},
		{Labels: []prompb.Label{{Name: "__name__", Value: ""}}, Samples: []prompb.Sample{{Value: 1, Timestamp: 1}}},
		{Labels: []prompb.Label{{Name: "__name__", Value: "metric"}, {Name: "job", Value: "x"}, {Name: "job", Value: "y"}}, Samples: []prompb.Sample{{Value: 1, Timestamp: 1}}},
		{Labels: []prompb.Label{{Name: "__name__", Value: "metric"}, {Name: "bad label", Value: "x"}}, Samples: []prompb.Sample{{Value: 1, Timestamp: 1}}},
		{Labels: []prompb.Label{{Name: "__name__", Value: "metric"}}},
	}
	for i, ts := range cases {
		r := &prompb.WriteRequest{Timeseries: []prompb.TimeSeries{ts}}
		if err := InjectLabels(r, trusted); err == nil {
			t.Fatalf("accepted malformed series %d", i)
		}
	}
}
func TestLabelsRejectInvalidIdentity(t *testing.T) {
	if err := InjectLabels(sampleRequest(), auth.Agent{}); err == nil {
		t.Fatal("accepted missing trusted identity")
	}
}
func TestNativeHistogramIsNotDropped(t *testing.T) {
	r := sampleRequest()
	r.Timeseries[0].Samples = nil
	r.Timeseries[0].Histograms = []prompb.Histogram{{Timestamp: 1720000000000}}
	if err := InjectLabels(r, trusted); err != nil {
		t.Fatal(err)
	}
	if len(r.Timeseries[0].Histograms) != 1 {
		t.Fatal("histogram dropped")
	}
}
