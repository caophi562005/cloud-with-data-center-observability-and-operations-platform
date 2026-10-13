// Package smoke verifies real Remote Write and optionally explicit query credentials.
package smoke

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/config"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/remotewrite"
	"github.com/prometheus/prometheus/prompb"
)

const Metric = "opsgrid_step6_smoke_test"

type Result struct {
	WritePass   bool
	WriteStatus int
	QueryState  string
	QueryStatus int
	Reason      string
}

func Run(ctx context.Context, cfg config.Smoke) Result {
	result := Result{QueryState: "NOT VERIFIED"}
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		result.Reason = "cannot generate smoke identifier"
		return result
	}
	id := hex.EncodeToString(random[:])
	stamp := time.Now().UTC().UnixMilli()
	request := &prompb.WriteRequest{Timeseries: []prompb.TimeSeries{{Labels: []prompb.Label{{Name: "__name__", Value: Metric}, {Name: "smoke_id", Value: id}, {Name: "source", Value: "metrics-smoke"}}, Samples: []prompb.Sample{{Value: 1, Timestamp: stamp}}}}}
	body, err := remotewrite.Encode(request)
	if err != nil {
		result.Reason = "cannot encode smoke metric"
		return result
	}
	writer := remotewrite.NewForwarder(cfg.Write.URL, cfg.Write.Auth, cfg.Write.Timeout)
	defer writer.Close()
	response, err := writer.Send(ctx, body)
	result.WriteStatus = response.StatusCode
	if err != nil {
		result.Reason = "Remote Write transport failed (DNS/TLS/network/timeout)"
		return result
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result.Reason = "metrics backend rejected smoke write"
		return result
	}
	result.WritePass = true
	if cfg.QueryError != nil {
		result.QueryState = "FAIL"
		result.Reason = "invalid explicit METRICS_QUERY_* configuration"
		return result
	}
	if cfg.Query == nil {
		result.Reason = "METRICS_QUERY_* not fully configured; required for Step 7 NestJS Metrics API"
		return result
	}
	result.QueryState = "FAIL"
	queryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	client := &http.Client{Transport: transport, Timeout: cfg.Query.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	for {
		query := Metric + `{source="metrics-smoke",smoke_id="` + id + `"}`
		form := url.Values{"query": []string{query}}
		req, err := http.NewRequestWithContext(queryCtx, http.MethodPost, cfg.Query.URL, strings.NewReader(form.Encode()))
		if err != nil {
			result.Reason = "cannot construct query request"
			return result
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if err := cfg.Query.Auth.Apply(req); err != nil {
			result.Reason = "invalid query authentication configuration"
			return result
		}
		resp, err := client.Do(req)
		if err != nil {
			result.Reason = "query transport failed (DNS/TLS/network/timeout)"
			return result
		}
		result.QueryStatus = resp.StatusCode
		payload, readErr := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
		resp.Body.Close()
		if resp.StatusCode != 200 || readErr != nil || len(payload) > 1<<20 {
			result.Reason = "query API rejected request or response was invalid"
			return result
		}
		if hasSample(payload, id, stamp) {
			result.QueryState = "PASS"
			result.Reason = ""
			return result
		}
		var envelope struct{ Status string }
		if json.Unmarshal(payload, &envelope) != nil || envelope.Status != "success" {
			result.Reason = "query API returned invalid Prometheus response"
			return result
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-queryCtx.Done():
			timer.Stop()
			result.Reason = "smoke sample not visible within bounded query-back window"
			return result
		case <-timer.C:
		}
	}
}
func hasSample(body []byte, id string, stamp int64) bool {
	var response struct {
		Status string
		Data   struct {
			ResultType string
			Result     []struct {
				Metric map[string]string
				Value  []json.RawMessage
			}
		}
	}
	if json.Unmarshal(body, &response) != nil || response.Status != "success" || response.Data.ResultType != "vector" {
		return false
	}
	for _, sample := range response.Data.Result {
		if sample.Metric["__name__"] != Metric || sample.Metric["source"] != "metrics-smoke" || sample.Metric["smoke_id"] != id || len(sample.Value) != 2 {
			continue
		}
		var timestamp float64
		var value string
		if json.Unmarshal(sample.Value[0], &timestamp) != nil || json.Unmarshal(sample.Value[1], &value) != nil {
			continue
		}
		n, err := strconv.ParseFloat(value, 64)
		if err == nil && n == 1 && timestamp >= float64(stamp-1000)/1000 {
			return true
		}
	}
	return false
}
