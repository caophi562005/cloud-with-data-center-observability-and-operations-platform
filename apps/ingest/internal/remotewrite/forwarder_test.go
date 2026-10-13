package remotewrite

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	upstreamauth "github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/upstream"
)

func basicAuth(t *testing.T, username, token string) upstreamauth.Auth {
	t.Helper()
	auth, err := upstreamauth.NewAuth(upstreamauth.ModeBasic, username, token)
	if err != nil {
		t.Fatal(err)
	}
	return auth
}

// Detects missing wire headers, credential leakage to redirects and false ACKs.
func TestForwarderWireContractAndStatus(t *testing.T) {
	for _, status := range []int{200, 204, 400, 401, 403, 429, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				u, p, ok := r.BasicAuth()
				if !ok || u != "tenant" || p != "upstream-private" {
					t.Error("missing Basic Auth")
				}
				for k, v := range map[string]string{"Content-Type": "application/x-protobuf", "Content-Encoding": "snappy", "X-Prometheus-Remote-Write-Version": "0.1.0"} {
					if r.Header.Get(k) != v {
						t.Errorf("wrong %s", k)
					}
				}
				b, _ := io.ReadAll(r.Body)
				if string(b) != "encoded" {
					t.Error("body changed")
				}
				w.Header().Set("Retry-After", "5")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("private upstream details"))
			}))
			defer up.Close()
			f := NewForwarder(up.URL, basicAuth(t, "tenant", "upstream-private"), 5*time.Second)
			defer f.Close()
			result, err := f.Send(context.Background(), []byte("encoded"))
			if err != nil || result.StatusCode != status {
				t.Fatalf("status lost: %d %v", result.StatusCode, err)
			}
			if result.RetryAfter != "5" {
				t.Fatal("retry guidance lost")
			}
		})
	}
}
func TestForwarderDoesNotFollowRedirect(t *testing.T) {
	var destinationCalls, sourceCalls atomic.Int32
	dest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationCalls.Add(1) }))
	defer dest.Close()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sourceCalls.Add(1)
		http.Redirect(w, r, dest.URL, 302)
	}))
	defer up.Close()
	f := NewForwarder(up.URL, basicAuth(t, "tenant", "private"), 5*time.Second)
	defer f.Close()
	r, err := f.Send(context.Background(), nil)
	if err != nil || r.StatusCode != 302 || destinationCalls.Load() != 0 || sourceCalls.Load() != 1 {
		t.Fatal("redirect followed")
	}
}
func TestForwarderTimeoutIsSanitized(t *testing.T) {
	var calls atomic.Int32
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
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
	f := NewForwarder(up.URL, basicAuth(t, "tenant", "private"), 100*time.Millisecond)
	defer f.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := f.Send(ctx, nil)
	if err != ErrUpstreamUnavailable || result != (Result{}) || calls.Load() != 1 {
		t.Fatal("timeout not sanitized or request retried")
	}
}

type wireAuthCase struct {
	name, username, token, authorization string
	auth                                 upstreamauth.Auth
}

func wireAuthCases(t *testing.T) []wireAuthCase {
	t.Helper()
	cases := []wireAuthCase{
		{name: "none", username: "ignored:username\n", token: "ignored token\n"},
		{name: "basic", username: "wire-user", token: "wire-private", authorization: "Basic " + base64.StdEncoding.EncodeToString([]byte("wire-user:wire-private"))},
		{name: "bearer", username: "ignored:username\n", token: "wire-private", authorization: "Bearer wire-private"},
	}
	for i := range cases {
		var err error
		cases[i].auth, err = upstreamauth.NewAuth(upstreamauth.Mode(cases[i].name), cases[i].username, cases[i].token)
		if err != nil {
			t.Fatal("invalid synthetic auth fixture")
		}
	}
	return cases
}

// Detects URL rewriting, auth/header drift, raw credential leakage and payload changes.
func assertWireRequest(t *testing.T, r *http.Request, body, want []byte, tc wireAuthCase) {
	t.Helper()
	if r.Method != http.MethodPost || r.URL.RequestURI() != "/workspaces/ws-test/api/v1/remote_write" {
		t.Error("remote write method or exact AMP path changed")
	}
	if !bytes.Equal(body, want) {
		t.Error("supplied encoded bytes changed at wire boundary")
	}
	for key, value := range map[string]string{
		"Content-Type": "application/x-protobuf", "Content-Encoding": "snappy",
		"X-Prometheus-Remote-Write-Version": "0.1.0", "User-Agent": "opsgrid-ingest/1",
	} {
		if r.Header.Get(key) != value {
			t.Errorf("incorrect wire header %s", key)
		}
	}
	values := r.Header.Values("Authorization")
	if tc.authorization == "" {
		if len(values) != 0 {
			t.Error("none mode emitted Authorization")
		}
	} else if len(values) != 1 || values[0] != tc.authorization {
		t.Error("incorrect or duplicate upstream Authorization")
	}
	for key, values := range r.Header {
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, "x-amz-") || lower == "x-aws-ec2-metadata-token" {
			t.Error("unexpected AWS signing header")
		}
		for _, value := range values {
			if strings.Contains(value, "AGT_test") || strings.Contains(value, "AWS4-HMAC-SHA256") {
				t.Error("ingress credential or AWS signing leaked upstream")
			}
		}
	}
	for _, credential := range []string{tc.username, tc.token, "AGT_test"} {
		if strings.Contains(r.URL.RequestURI(), credential) || bytes.Contains(body, []byte(credential)) {
			t.Error("credential leaked into path or encoded body")
		}
	}
}

func TestForwarderAuthModesAndAMPPath(t *testing.T) {
	payload, err := Encode(sampleRequest())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range wireAuthCases(t) {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				body, err := io.ReadAll(r.Body)
				if err != nil {
					t.Error("cannot read synthetic request")
				}
				assertWireRequest(t, r, body, payload, tc)
				w.WriteHeader(http.StatusNoContent)
			}))
			defer up.Close()
			f := NewForwarder(up.URL+"/workspaces/ws-test/api/v1/remote_write", tc.auth, time.Second)
			defer f.Close()
			transport, ok := f.client.Transport.(*http.Transport)
			if !ok || transport.MaxIdleConns != 64 || transport.MaxIdleConnsPerHost != 64 || transport.MaxConnsPerHost != 64 {
				t.Fatal("connection limits changed")
			}
			result, err := f.Send(context.Background(), payload)
			if err != nil || result != (Result{StatusCode: 204}) || calls.Load() != 1 {
				t.Fatal("wire send failed or request retried")
			}
		})
	}
}

// Detects ignoring Apply validation and silently sending unauthenticated requests.
func TestForwarderInvalidAuthDoesNotSend(t *testing.T) {
	for _, name := range []string{"zero", "unknown", "invalid_basic", "invalid_bearer"} {
		t.Run(name, func(t *testing.T) {
			var auth upstreamauth.Auth
			if name != "zero" {
				mode, username, token := upstreamauth.Mode("unsupported"), "", ""
				if name == "invalid_basic" {
					mode, username, token = upstreamauth.ModeBasic, "bad:username", "private"
				} else if name == "invalid_bearer" {
					mode, token = upstreamauth.ModeBearer, "bad token"
				}
				var err error
				auth, err = upstreamauth.NewAuth(mode, username, token)
				if err == nil {
					t.Fatal("invalid synthetic auth accepted")
				}
			}
			var calls atomic.Int32
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
			defer up.Close()
			f := NewForwarder(up.URL, auth, time.Second)
			defer f.Close()
			result, err := f.Send(context.Background(), []byte("encoded"))
			if err != ErrUpstreamUnavailable || result != (Result{}) || calls.Load() != 0 {
				t.Fatal("invalid auth sent a request or exposed validation details")
			}
		})
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return fn(r) }

type countedResponseBody struct {
	reader   io.Reader
	read     atomic.Int64
	closed   atomic.Int32
	closeErr error
}

func (b *countedResponseBody) Read(p []byte) (int, error) {
	n, err := b.reader.Read(p)
	b.read.Add(int64(n))
	return n, err
}
func (b *countedResponseBody) Close() error {
	b.closed.Add(1)
	return b.closeErr
}

type responseReadError struct{}

func (responseReadError) Read([]byte) (int, error) {
	return 0, errors.New("private upstream read details")
}

// Detects unbounded draining, missing Close, retries, and loss of received status on body errors.
func TestForwarderBoundedFailureHandling(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		reader   io.Reader
		closeErr error
		wantRead int64
	}{
		{"large_success", 200, strings.NewReader(strings.Repeat("x", 32<<10)), nil, 16 << 10},
		{"large_failure", 503, strings.NewReader(strings.Repeat("x", 32<<10)), nil, 16 << 10},
		{"read_error", 429, io.MultiReader(strings.NewReader("private upstream body"), responseReadError{}), nil, int64(len("private upstream body"))},
		{"close_error", 422, strings.NewReader("private upstream body"), errors.New("private close details"), int64(len("private upstream body"))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := &countedResponseBody{reader: tc.reader, closeErr: tc.closeErr}
			var calls atomic.Int32
			f := NewForwarder("http://127.0.0.1/workspaces/ws-test/api/v1/remote_write", basicAuth(t, "wire-user", "wire-private"), time.Second)
			defer f.Close()
			f.client.Transport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Retry-After": {"7"}}, Body: body, Request: r}, nil
			})
			result, err := f.Send(context.Background(), []byte("encoded"))
			if err != nil || result != (Result{StatusCode: tc.status, RetryAfter: "7"}) {
				t.Fatal("response body error redefined status or exposed private details")
			}
			if body.read.Load() != tc.wantRead || body.read.Load() > 16<<10 || body.closed.Load() != 1 || calls.Load() != 1 {
				t.Fatal("drain/close bound violated or request retried")
			}
		})
	}
	for _, tc := range wireAuthCases(t) {
		t.Run(tc.name, func(t *testing.T) {
			t.Run("transport", func(t *testing.T) {
				var calls atomic.Int32
				f := NewForwarder("http://127.0.0.1/workspaces/ws-test/api/v1/remote_write", tc.auth, time.Second)
				defer f.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				f.client.Transport = roundTripperFunc(func(r *http.Request) (*http.Response, error) {
					calls.Add(1)
					if r.Context().Value(contextMarker{}) != "caller" {
						t.Error("caller context lost")
					}
					return nil, errors.New("private transport details " + tc.username + tc.token)
				})
				result, err := f.Send(context.WithValue(ctx, contextMarker{}, "caller"), []byte("encoded"))
				if result != (Result{}) || err != ErrUpstreamUnavailable || calls.Load() != 1 {
					t.Fatal("transport error not sanitized or request retried")
				}
			})
			t.Run("refused", func(t *testing.T) {
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				address := listener.Addr().String()
				if err := listener.Close(); err != nil {
					t.Fatal(err)
				}
				f := NewForwarder("http://"+address+"/workspaces/ws-test/api/v1/remote_write", tc.auth, 100*time.Millisecond)
				defer f.Close()
				result, err := f.Send(context.Background(), []byte("encoded"))
				if result != (Result{}) || err != ErrUpstreamUnavailable {
					t.Fatal("refused connection not sanitized")
				}
			})
			t.Run("cancelled", func(t *testing.T) {
				var calls atomic.Int32
				up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
				defer up.Close()
				f := NewForwarder(up.URL, tc.auth, time.Second)
				defer f.Close()
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				result, err := f.Send(ctx, []byte("encoded"))
				if result != (Result{}) || err != ErrUpstreamUnavailable || calls.Load() != 0 {
					t.Fatal("cancelled caller sent a request or exposed transport details")
				}
			})
		})
	}
	for _, status := range []int{429, 503} {
		t.Run("stalled_body_"+http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			release := make(chan struct{})
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				_, _ = io.Copy(io.Discard, r.Body)
				w.Header().Set("Content-Length", "32768")
				w.Header().Set("Retry-After", "9")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("x"))
				w.(http.Flusher).Flush()
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
			start := time.Now()
			result, err := f.Send(ctx, []byte("encoded"))
			if err != nil || result != (Result{StatusCode: status, RetryAfter: "9"}) || calls.Load() != 1 {
				t.Fatal("stalled body redefined received status or request retried")
			}
			if time.Since(start) >= 2*time.Second || ctx.Err() != nil {
				t.Fatal("response body drain exceeded test deadline")
			}
		})
	}
}

type contextMarker struct{}
