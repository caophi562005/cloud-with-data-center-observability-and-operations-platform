package server

import (
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"
)

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *responseWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *responseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func middleware(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !safeID(id) {
			var bytes [16]byte
			if _, err := rand.Read(bytes[:]); err != nil {
				http.Error(w, "request unavailable", 503)
				return
			}
			id = hex.EncodeToString(bytes[:])
		}
		w.Header().Set("X-Request-ID", id)
		writer := &responseWriter{ResponseWriter: w}
		start := time.Now()
		defer func() {
			if recover() != nil {
				logger.ErrorContext(r.Context(), "request panic recovered", "request_id", id, "error", "internal error")
				if writer.status == 0 {
					http.Error(writer, "internal error", 500)
				}
			}
			status := writer.status
			if status == 0 {
				status = 200
			}
			logger.InfoContext(r.Context(), "http_request", "request_id", id, "status", status, "duration_ms", time.Since(start).Milliseconds())
		}()
		next.ServeHTTP(writer, r)
	})
}
func safeID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' {
			continue
		}
		return false
	}
	return true
}
