package remotewrite

import (
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/prometheus/prometheus/prompb"
	"sort"
	"unicode/utf8"
)

// InjectLabels replaces ALL client identity labels; other valid labels are preserved.
// Minimal structural validation only; timestamps/values/backend constraints stay upstream.
func InjectLabels(req *prompb.WriteRequest, agent auth.Agent) error {
	if agent.AgentID == "" || agent.VMID == "" || agent.OrganizationID == "" || len(req.Timeseries) == 0 {
		return ErrInvalidPayload
	}
	for i := range req.Timeseries {
		ts := &req.Timeseries[i]
		if len(ts.Samples) == 0 && len(ts.Histograms) == 0 {
			return ErrInvalidPayload
		}
		labels := make([]prompb.Label, 0, len(ts.Labels)+3)
		seen := make(map[string]bool, len(ts.Labels))
		hasName := false
		for _, l := range ts.Labels {
			if l.Name == "agent_id" || l.Name == "vm_id" || l.Name == "organization_id" {
				continue
			}
			if !validName(l.Name, false) || !utf8.ValidString(l.Value) || seen[l.Name] {
				return ErrInvalidPayload
			}
			seen[l.Name] = true
			if l.Name == "__name__" {
				if !validName(l.Value, true) {
					return ErrInvalidPayload
				}
				hasName = true
			}
			labels = append(labels, l)
		}
		if !hasName {
			return ErrInvalidPayload
		}
		labels = append(labels, prompb.Label{Name: "agent_id", Value: agent.AgentID}, prompb.Label{Name: "vm_id", Value: agent.VMID}, prompb.Label{Name: "organization_id", Value: agent.OrganizationID})
		sort.Slice(labels, func(i, j int) bool { return labels[i].Name < labels[j].Name })
		ts.Labels = labels
	}
	return nil
}
func validName(s string, metric bool) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || (metric && c == ':') || (i > 0 && c >= '0' && c <= '9') {
			continue
		}
		return false
	}
	return true
}
