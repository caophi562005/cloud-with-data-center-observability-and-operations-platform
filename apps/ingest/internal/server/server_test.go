package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Detects accidental readiness dependence for liveness and missing HTTP middleware.
func TestEndpointsAndReadiness(t *testing.T) {
	for _, ready := range []bool{true, false} {
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		h := NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }), func(ctx context.Context) error {
			if !ready {
				return errors.New("private db connection")
			}
			return nil
		}, logger)
		for _, tc := range []struct {
			method, path string
			want         int
		}{{"GET", "/health", 200}, {"GET", "/ready", map[bool]int{true: 200, false: 503}[ready]}, {"POST", "/api/v1/write", 204}, {"GET", "/api/v1/write", 405}, {"GET", "/health/extra", 404}, {"POST", "/health", 405}} {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.Header.Set("X-Request-ID", "test-request-123")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want || w.Header().Get("X-Request-ID") != "test-request-123" || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("%s: %d", tc.path, w.Code)
			}
		}
	}
}
func TestRequestIDRejectsUnsafeValueAndRecovers(t *testing.T) {
	var logs strings.Builder
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	h := NewHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { panic("private panic details") }), func(context.Context) error { return nil }, logger)
	r := httptest.NewRequest("POST", "/api/v1/write", nil)
	r.Header.Set("X-Request-ID", "unsafe request with spaces")
	r.Header.Set("Authorization", "Bearer AGT_private")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	id := w.Header().Get("X-Request-ID")
	if w.Code != 500 || len(id) != 32 || strings.Contains(logs.String(), "private") || strings.Contains(w.Body.String(), "private") {
		t.Fatal("unsafe recovery or request ID")
	}
}
