// Package e2epayload builds offline Remote Write v1 fixtures, never credentials or network requests.
package e2epayload

import (
	"errors"
	"regexp"
	"sort"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
	"github.com/prometheus/prometheus/prompb"
)

type Options struct {
	Kind                string
	RunID               string
	TimestampMillis     int64
	MaxBytes            int64
	SpoofOrganizationID string
	SpoofVMID           string
	SpoofAgentID        string
}

var runIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var errOptions = errors.New("invalid fixture options")

func Build(options Options) ([]byte, error) {
	if !runIDPattern.MatchString(options.RunID) || options.TimestampMillis <= 0 || options.MaxBytes < 1 || options.MaxBytes > 67108864 {
		return nil, errOptions
	}
	switch options.Kind {
	case "corrupt-snappy":
		return []byte{0xff}, nil
	case "oversize":
		return make([]byte, int(options.MaxBytes)+1), nil
	case "valid", "spoof", "missing-name", "duplicate-label":
	default:
		return nil, errOptions
	}
	labels := []prompb.Label{{Name: "run_id", Value: options.RunID}, {Name: "case_id", Value: options.Kind}}
	if options.Kind != "missing-name" {
		labels = append(labels, prompb.Label{Name: "__name__", Value: "opsgrid_amp_e2e_probe"})
	}
	if options.Kind == "duplicate-label" {
		labels = append(labels, prompb.Label{Name: "run_id", Value: options.RunID})
	}
	if options.Kind == "spoof" {
		if options.SpoofOrganizationID == "" || options.SpoofVMID == "" || options.SpoofAgentID == "" {
			return nil, errOptions
		}
		labels = append(labels,
			prompb.Label{Name: "organization_id", Value: options.SpoofOrganizationID},
			prompb.Label{Name: "vm_id", Value: options.SpoofVMID},
			prompb.Label{Name: "agent_id", Value: options.SpoofAgentID})
	}
	sort.SliceStable(labels, func(i, j int) bool { return labels[i].Name < labels[j].Name })
	return remotewrite.Encode(&prompb.WriteRequest{Timeseries: []prompb.TimeSeries{{
		Labels: labels, Samples: []prompb.Sample{{Value: 1, Timestamp: options.TimestampMillis}},
	}}})
}
