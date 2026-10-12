package remotewrite

import (
	"context"
	"errors"
	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Authenticator interface {
	Authenticate(context.Context, string) (auth.Agent, error)
}
type AgentLimiter interface{ Allow(string) bool }
type Handler struct {
	auth      Authenticator
	limiter   AgentLimiter
	forwarder *Forwarder
	maxBytes  int64
	logger    *slog.Logger
}

func NewHandler(a Authenticator, l AgentLimiter, f *Forwarder, maxBytes int64, logger *slog.Logger) *Handler {
	return &Handler{auth: a, limiter: l, forwarder: f, maxBytes: maxBytes, logger: logger}
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	status := http.StatusInternalServerError
	upStatus := 0
	var agent auth.Agent
	errorKind := ""
	defer func() {
		h.logger.InfoContext(r.Context(), "remote_write", "request_id", w.Header().Get("X-Request-ID"), "agent_id", agent.AgentID, "vm_id", agent.VMID, "organization_id", agent.OrganizationID, "status", status, "duration_ms", time.Since(start).Milliseconds(), "upstream_status", upStatus, "error", errorKind)
	}()
	fail := func(code int, message string) { status = code; errorKind = message; http.Error(w, message, code) }
	if len(r.Header.Values("Authorization")) > 1 {
		fail(401, "unauthorized")
		return
	}
	var err error
	agent, err = h.auth.Authenticate(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, auth.ErrUnauthorized) {
			fail(401, "unauthorized")
		} else {
			w.Header().Set("Retry-After", "1")
			fail(503, "authentication unavailable")
		}
		return
	}
	if !h.limiter.Allow(agent.AgentID) {
		w.Header().Set("Retry-After", "1")
		fail(429, "agent rate limited")
		return
	}
	contentType, params, e := mime.ParseMediaType(r.Header.Get("Content-Type"))
	proto := params["proto"]
	version := r.Header.Get("X-Prometheus-Remote-Write-Version")
	if e != nil || contentType != "application/x-protobuf" || !strings.EqualFold(r.Header.Get("Content-Encoding"), "snappy") || (proto != "" && proto != "prometheus.WriteRequest") || (version != "" && version != "0.1.0") {
		fail(400, "unsupported remote write protocol (v1 protobuf and snappy required)")
		return
	}
	if r.ContentLength > h.maxBytes {
		fail(413, "remote write payload too large")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, h.maxBytes)
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			fail(413, "remote write payload too large")
		} else {
			fail(400, "cannot read remote write payload")
		}
		return
	}
	req, err := Decode(body, h.maxBytes)
	if err != nil {
		if errors.Is(err, ErrTooLarge) {
			fail(413, "remote write payload too large")
		} else {
			fail(400, "invalid remote write payload")
		}
		return
	}
	if err = InjectLabels(req, agent); err != nil {
		fail(400, "invalid remote write series")
		return
	}
	if int64(req.Size()) > h.maxBytes {
		fail(413, "normalized remote write payload too large")
		return
	}
	payload, err := Encode(req)
	if err != nil {
		fail(400, "cannot encode remote write payload")
		return
	}
	result, err := h.forwarder.Send(r.Context(), payload)
	if err != nil {
		fail(502, "metrics upstream unavailable")
		return
	}
	upStatus = result.StatusCode
	if upStatus >= 200 && upStatus < 300 {
		status = 204
		w.WriteHeader(status)
		return
	}
	switch upStatus {
	case 400, 413, 422:
		fail(upStatus, "metrics upstream rejected payload")
	case 429:
		if validRetryAfter(result.RetryAfter) {
			w.Header().Set("Retry-After", result.RetryAfter)
		} else {
			w.Header().Set("Retry-After", "1")
		}
		fail(429, "metrics upstream rate limited")
	default:
		fail(502, "metrics upstream unavailable or misconfigured")
	}
}
func validRetryAfter(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	if n, e := strconv.ParseInt(value, 10, 64); e == nil && n >= 0 {
		return true
	}
	_, e := http.ParseTime(value)
	return e == nil
}
