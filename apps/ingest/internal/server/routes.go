package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// NewHandler keeps liveness independent of dependency failures. Readiness only pings DB.
// Upstream configuration was validated at startup; Redis is optional at request time.
func NewHandler(write http.Handler, ready func(context.Context) error, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /ready", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if ready(ctx) != nil {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready\n"))
	})
	mux.Handle("POST /api/v1/write", write)
	return middleware(mux, logger)
}
