package remotewrite

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	upstreamauth "github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/upstream"
)

var ErrUpstreamUnavailable = errors.New("metrics upstream unavailable")

type Result struct {
	StatusCode int
	RetryAfter string
}
type Forwarder struct {
	url    string
	auth   upstreamauth.Auth
	client *http.Client
}

func NewForwarder(url string, auth upstreamauth.Auth, timeout time.Duration) *Forwarder {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns = 64
	transport.MaxIdleConnsPerHost = 64
	transport.MaxConnsPerHost = 64
	transport.ResponseHeaderTimeout = timeout
	return &Forwarder{url: url, auth: auth, client: &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (f *Forwarder) Close() { f.client.CloseIdleConnections() }
func (f *Forwarder) Send(ctx context.Context, payload []byte) (Result, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, f.url, bytes.NewReader(payload))
	if err != nil {
		return Result{}, ErrUpstreamUnavailable
	}
	if err := f.auth.Apply(req); err != nil {
		return Result{}, ErrUpstreamUnavailable
	}
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Content-Encoding", "snappy")
	req.Header.Set("X-Prometheus-Remote-Write-Version", "0.1.0")
	req.Header.Set("User-Agent", "opsgrid-ingest/1")
	resp, err := f.client.Do(req)
	if err != nil {
		return Result{}, ErrUpstreamUnavailable
	}
	defer resp.Body.Close()
	// Never expose/log upstream body: it may include private configuration. Bound draining.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 16<<10))
	return Result{StatusCode: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After")}, nil
}
