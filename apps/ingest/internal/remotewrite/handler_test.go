package remotewrite

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/ratelimit"
	"github.com/prometheus/prometheus/prompb"
)

type authStub struct{ err error }

func (a authStub) Authenticate(ctx context.Context, header string) (auth.Agent, error) {
	return trusted, a.err
}
func newTestHandler(t *testing.T, upStatus int, authErr error, max int64, limiter *ratelimit.Limiter) (http.Handler, *atomic.Int32) {
	t.Helper()
	var called atomic.Int32
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		b, _ := io.ReadAll(r.Body)
		wr, err := Decode(b, 1<<20)
		if err != nil {
			t.Error(err)
		} else {
			for _, l := range wr.Timeseries[0].Labels {
				if l.Name == "vm_id" && l.Value != trusted.VMID {
					t.Error("untrusted labels forwarded")
				}
			}
		}
		w.Header().Set("Retry-After", "3")
		w.WriteHeader(upStatus)
		_, _ = w.Write([]byte("private upstream detail"))
	}))
	t.Cleanup(up.Close)
	f := NewForwarder(up.URL, basicAuth(t, "tenant", "private"), 5*time.Second)
	t.Cleanup(f.Close)
	return NewHandler(authStub{authErr}, limiter, f, max, slog.New(slog.NewTextHandler(io.Discard, nil))), &called
}
func callWrite(h http.Handler, b []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/write", bytes.NewReader(b))
	r.Header.Set("Authorization", "Bearer AGT_test")
	r.Header.Set("Content-Type", "application/x-protobuf")
	r.Header.Set("Content-Encoding", "snappy")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}
func TestHandlerNormalizedPayloadLimit(t *testing.T) {
	b, _ := Encode(sampleRequest())
	h, called := newTestHandler(t, 204, nil, 100, ratelimit.New(5, 20))
	if len(b) > 100 {
		t.Fatal("fixture exceeds input limit")
	}
	w := callWrite(h, b)
	if w.Code != 413 || called.Load() != 0 {
		t.Fatal("normalized payload escaped body limit")
	}
}
func TestHandlerStatusSemantics(t *testing.T) {
	for _, tc := range []struct{ up, want int }{{200, 204}, {201, 204}, {202, 204}, {204, 204}, {206, 204}, {299, 204}, {400, 400}, {422, 422}, {413, 413}, {401, 502}, {403, 502}, {404, 502}, {429, 429}, {500, 502}, {503, 502}, {302, 502}} {
		t.Run(strconv.Itoa(tc.up)+"_"+http.StatusText(tc.up), func(t *testing.T) {
			h, called := newTestHandler(t, tc.up, nil, 4096, ratelimit.New(5, 20))
			b, _ := Encode(sampleRequest())
			w := callWrite(h, b)
			if w.Code != tc.want || called.Load() != 1 {
				t.Fatalf("unsafe status or retry: %d, calls=%d", w.Code, called.Load())
			}
			wantBody := "metrics upstream unavailable or misconfigured\n"
			switch tc.want {
			case 204:
				wantBody = ""
			case 400, 413, 422:
				wantBody = "metrics upstream rejected payload\n"
			case 429:
				wantBody = "metrics upstream rate limited\n"
			}
			if w.Body.String() != wantBody {
				t.Fatal("public response exposed upstream body or success was not empty")
			}
			wantRetry := ""
			if tc.up == 429 {
				wantRetry = "3"
			}
			if w.Header().Get("Retry-After") != wantRetry {
				t.Fatal("retry-after not sanitized for status")
			}
		})
	}
}
func TestHandlerAuthenticationAndBodyLimit(t *testing.T) {
	for _, tc := range []struct {
		err  error
		max  int64
		want int
	}{{auth.ErrUnauthorized, 4096, 401}, {auth.ErrUnavailable, 4096, 503}, {nil, 10, 413}} {
		h, called := newTestHandler(t, 204, tc.err, tc.max, ratelimit.New(5, 20))
		b, _ := Encode(sampleRequest())
		w := callWrite(h, b)
		if w.Code != tc.want || called.Load() != 0 {
			t.Fatalf("got %d, upstream calls=%d", w.Code, called.Load())
		}
	}
}
func TestHandlerChunkedLimit(t *testing.T) {
	h, called := newTestHandler(t, 204, nil, 10, ratelimit.New(5, 20))
	r := httptest.NewRequest("POST", "/api/v1/write", bytes.NewReader(make([]byte, 11)))
	r.ContentLength = -1
	r.Header.Set("Content-Type", "application/x-protobuf")
	r.Header.Set("Content-Encoding", "snappy")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 413 || called.Load() != 0 {
		t.Fatal("chunked body escaped limit")
	}
}
func TestHandlerRateLimit(t *testing.T) {
	h, calls := newTestHandler(t, 204, nil, 4096, ratelimit.New(0.001, 1))
	b, _ := Encode(sampleRequest())
	if callWrite(h, b).Code != 204 || calls.Load() != 1 {
		t.Fatal("first denied or retried")
	}
	limited := callWrite(h, b)
	if limited.Code != 429 || limited.Header().Get("Retry-After") != "1" || calls.Load() != 1 {
		t.Fatal("second not limited or forwarded despite rate rejection")
	}
}
func TestHandlerRejectHeadersAndCorruptBody(t *testing.T) {
	h, called := newTestHandler(t, 204, nil, 4096, ratelimit.New(5, 20))
	b, _ := Encode(sampleRequest())
	for _, tc := range []struct{ ct, ce, version string }{{"application/json", "snappy", ""}, {"application/x-protobuf", "gzip", ""}, {"application/x-protobuf; proto=io.prometheus.write.v2.Request", "snappy", "2.0.0"}, {"application/x-protobuf", "snappy", "2.0.0"}} {
		r := httptest.NewRequest("POST", "/api/v1/write", bytes.NewReader(b))
		r.Header.Set("Content-Type", tc.ct)
		r.Header.Set("Content-Encoding", tc.ce)
		r.Header.Set("X-Prometheus-Remote-Write-Version", tc.version)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 || called.Load() != 0 {
			t.Fatal("incompatible protocol accepted")
		}
	}
	if callWrite(h, []byte("corrupt")).Code != 400 || called.Load() != 0 {
		t.Fatal("corrupt accepted or forwarded")
	}
}

// Detects bypassing normalization, retained duplicate/spoofed identities and mode-dependent wire drift.
func TestHandlerTrustedLabelsForAllModes(t *testing.T) {
	fixture := sampleRequest()
	fixture.Timeseries = append(fixture.Timeseries, prompb.TimeSeries{
		Labels:  []prompb.Label{{Name: "job", Value: "database"}, {Name: "__name__", Value: "second_metric"}},
		Samples: []prompb.Sample{{Value: 2, Timestamp: 1720000000001}},
	})
	for i := range fixture.Timeseries {
		spoofed := []prompb.Label{
			{Name: "vm_id", Value: "spoof-vm"}, {Name: "agent_id", Value: "spoof-agent"},
			{Name: "organization_id", Value: "spoof-org"}, {Name: "vm_id", Value: "spoof-vm-duplicate"},
			{Name: "agent_id", Value: "spoof-agent-duplicate"}, {Name: "organization_id", Value: "spoof-org-duplicate"},
		}
		fixture.Timeseries[i].Labels = append(spoofed, fixture.Timeseries[i].Labels...)
	}
	ingress, err := Encode(fixture)
	if err != nil {
		t.Fatal(err)
	}
	// A separate decode prevents sharing mutable label slices with the handler.
	normalized, err := Decode(ingress, 4096)
	if err != nil {
		t.Fatal(err)
	}
	if err := InjectLabels(normalized, trusted); err != nil {
		t.Fatal(err)
	}
	wantBody, err := Encode(normalized)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(ingress, wantBody) {
		t.Fatal("spoofed fixture does not require normalization")
	}
	for _, tc := range wireAuthCases(t) {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error("cannot read normalized wire payload")
					return
				}
				assertWireRequest(t, r, body, wantBody, tc)
				wr, err := Decode(body, 4096)
				if err != nil {
					t.Error("invalid normalized wire payload")
					return
				}
				if len(wr.Timeseries) != 2 {
					t.Error("series lost during normalization")
					return
				}
				for i, series := range wr.Timeseries {
					counts := map[string]int{}
					values := map[string]string{}
					previous := ""
					for _, label := range series.Labels {
						if label.Name <= previous {
							t.Error("labels not strictly sorted")
						}
						previous = label.Name
						counts[label.Name]++
						values[label.Name] = label.Value
						if strings.Contains(label.Value, "spoof") {
							t.Error("spoofed label survived")
						}
					}
					for name, value := range map[string]string{"agent_id": trusted.AgentID, "vm_id": trusted.VMID, "organization_id": trusted.OrganizationID} {
						if counts[name] != 1 || values[name] != value {
							t.Errorf("identity %s is not uniquely trusted", name)
						}
					}
					wantMetric, wantJob := "test_metric", "node"
					if i == 1 {
						wantMetric, wantJob = "second_metric", "database"
					}
					if len(series.Labels) != 5 || values["job"] != wantJob || values["__name__"] != wantMetric {
						t.Error("valid non-identity labels not preserved")
					}
					if len(series.Samples) != 1 || series.Samples[0].Value != float64(i+1) || series.Samples[0].Timestamp != 1720000000000+int64(i) {
						t.Error("sample changed during trusted normalization")
					}
				}
				w.WriteHeader(204)
			}))
			defer up.Close()
			f := NewForwarder(up.URL+"/workspaces/ws-test/api/v1/remote_write", tc.auth, time.Second)
			defer f.Close()
			h := NewHandler(authStub{}, ratelimit.New(5, 20), f, 4096, slog.New(slog.NewTextHandler(io.Discard, nil)))
			w := callWrite(h, ingress)
			if w.Code != 204 || w.Body.Len() != 0 || calls.Load() != 1 {
				t.Fatal("normalized request not accepted once with empty ACK")
			}
		})
	}
}

// Detects reflecting unsafe Retry-After values, losing valid dates/integers and retrying 429.
func TestHandlerRetryAfterValidation(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"integer", "17", "17"}, {"zero", "0", "0"},
		{"http_date", "Mon, 02 Jan 2006 15:04:05 GMT", "Mon, 02 Jan 2006 15:04:05 GMT"},
		{"missing", "", "1"}, {"invalid", "private upstream details", "1"},
		{"negative", "-1", "1"}, {"overlong", strings.Repeat("9", 129), "1"},
		{"overflow", "9223372036854775808", "1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if tc.input != "" {
					w.Header().Set("Retry-After", tc.input)
				}
				w.WriteHeader(429)
				_, _ = w.Write([]byte("private upstream body"))
			}))
			defer up.Close()
			f := NewForwarder(up.URL, basicAuth(t, "wire-user", "wire-private"), time.Second)
			defer f.Close()
			h := NewHandler(authStub{}, ratelimit.New(5, 20), f, 4096, slog.New(slog.NewTextHandler(io.Discard, nil)))
			b, err := Encode(sampleRequest())
			if err != nil {
				t.Fatal(err)
			}
			w := callWrite(h, b)
			if w.Code != 429 || w.Header().Get("Retry-After") != tc.want || w.Body.String() != "metrics upstream rate limited\n" || calls.Load() != 1 {
				t.Fatal("unsafe retry guidance/body, lost status, or application retry")
			}
		})
	}
}

// Detects raw transport/credential disclosure, false ACKs, context loss and retrying failed sends.
func TestHandlerTransportFailuresAreSanitized(t *testing.T) {
	for _, kind := range []string{"transport", "timeout", "refused", "cancelled", "redirect"} {
		t.Run(kind, func(t *testing.T) {
			var calls, destinationCalls atomic.Int32
			release := make(chan struct{})
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				deadline := time.NewTimer(2 * time.Second)
				defer deadline.Stop()
				select {
				case <-r.Context().Done():
				case <-release:
				case <-deadline.C:
				}
			}))
			defer up.Close()
			defer close(release)
			f := NewForwarder(up.URL, basicAuth(t, "wire-user", "wire-private"), 100*time.Millisecond)
			defer f.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			wantCalls := int32(1)
			wantBody := "metrics upstream unavailable\n"
			switch kind {
			case "transport":
				f.client.Transport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
					calls.Add(1)
					if r.Context().Value(contextMarker{}) != "handler-caller" {
						t.Error("handler caller context lost")
					}
					return nil, errors.New("private transport wire-user wire-private Bearer AGT_test")
				})
			case "refused":
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				address := listener.Addr().String()
				if err := listener.Close(); err != nil {
					t.Fatal(err)
				}
				f.url = "http://" + address
				wantCalls = 0
			case "cancelled":
				cancel()
				wantCalls = 0
			case "redirect":
				destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
				defer destination.Close()
				redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					http.Redirect(w, r, destination.URL, http.StatusFound)
				}))
				defer redirect.Close()
				f.url = redirect.URL
				wantBody = "metrics upstream unavailable or misconfigured\n"
			}
			h := NewHandler(authStub{}, ratelimit.New(5, 20), f, 4096, slog.New(slog.NewTextHandler(io.Discard, nil)))
			b, err := Encode(sampleRequest())
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "/api/v1/write", bytes.NewReader(b)).WithContext(context.WithValue(ctx, contextMarker{}, "handler-caller"))
			r.Header.Set("Authorization", "Bearer AGT_test")
			r.Header.Set("Content-Type", "application/x-protobuf")
			r.Header.Set("Content-Encoding", "snappy")
			w := httptest.NewRecorder()
			start := time.Now()
			h.ServeHTTP(w, r)
			if w.Code != 502 || w.Body.String() != wantBody || w.Header().Get("Retry-After") != "" || calls.Load() != wantCalls || destinationCalls.Load() != 0 {
				t.Fatal("transport failure not generic 502 or upstream retried/redirected")
			}
			if time.Since(start) >= 2*time.Second {
				t.Fatal("handler exceeded test deadline")
			}
		})
	}
}
