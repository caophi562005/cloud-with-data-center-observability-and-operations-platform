// Package config validates configuration without ever including secret values in errors.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	upstreamauth "github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/upstream"
	"github.com/joho/godotenv"
)

type Upstream struct {
	URL     string
	Auth    upstreamauth.Auth
	Timeout time.Duration
}
type Gateway struct {
	Port                  int
	LogLevel              slog.Level
	DatabaseURL, RedisURL string
	AuthCacheTTL          time.Duration
	Write                 Upstream
	MaxBodyBytes          int64
	RateRPS               float64
	RateBurst             int
}
type Smoke struct {
	Write      Upstream
	Query      *Upstream
	QueryError error
}

func LoadGateway() (Gateway, error) {
	if err := LoadDotEnv(); err != nil {
		return Gateway{}, err
	}
	return loadGateway(os.Getenv)
}
func LoadSmoke() (Smoke, error) {
	if err := LoadDotEnv(); err != nil {
		return Smoke{}, err
	}
	return loadSmoke(os.Getenv)
}

// Local convenience only: missing .env is fine, and existing environment values win.
func LoadDotEnv() error { return loadDotEnv(".env") }
func loadDotEnv(path string) error {
	err := godotenv.Load(path)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return errors.New("cannot load local dotenv configuration")
}
func Present(name string) bool { return strings.TrimSpace(os.Getenv(name)) != "" }

func loadGateway(get func(string) string) (Gateway, error) {
	var c Gateway
	var err error
	if c.Write, err = upstream(get, "METRICS_WRITE"); err != nil {
		return c, err
	}
	if c.DatabaseURL, err = required(get, "DATABASE_URL"); err != nil {
		return c, err
	}
	if err = validateURL(c.DatabaseURL, "DATABASE_URL", []string{"postgres", "postgresql"}, false); err != nil {
		return c, err
	}
	if c.RedisURL, err = required(get, "REDIS_URL"); err != nil {
		return c, err
	}
	if err = validateURL(c.RedisURL, "REDIS_URL", []string{"redis", "rediss"}, false); err != nil {
		return c, err
	}
	var n int64
	if n, err = integer(get, "PORT", 8080, 1, 65535); err != nil {
		return c, err
	}
	c.Port = int(n)
	if n, err = integer(get, "AGENT_AUTH_CACHE_TTL_SECONDS", 60, 1, 3600); err != nil {
		return c, err
	}
	c.AuthCacheTTL = time.Duration(n) * time.Second
	if c.MaxBodyBytes, err = integer(get, "REMOTE_WRITE_MAX_BODY_BYTES", 10485760, 1, 64<<20); err != nil {
		return c, err
	}
	if n, err = integer(get, "RATE_LIMIT_BURST", 20, 1, 100000); err != nil {
		return c, err
	}
	c.RateBurst = int(n)
	c.RateRPS = 5
	if v := get("RATE_LIMIT_REQUESTS_PER_SECOND"); v != "" {
		c.RateRPS, err = strconv.ParseFloat(v, 64)
		if err != nil || math.IsNaN(c.RateRPS) || math.IsInf(c.RateRPS, 0) || c.RateRPS < 0.001 || c.RateRPS > 10000 {
			return c, fmt.Errorf("RATE_LIMIT_REQUESTS_PER_SECOND must be finite and in [0.001, 10000]")
		}
	}
	level := get("LOG_LEVEL")
	if level == "" {
		level = "info"
	}
	if err = c.LogLevel.UnmarshalText([]byte(level)); err != nil {
		return c, errors.New("LOG_LEVEL must be debug, info, warn or error")
	}
	return c, nil
}
func loadSmoke(get func(string) string) (Smoke, error) {
	var c Smoke
	var err error
	if c.Write, err = upstream(get, "METRICS_WRITE"); err != nil {
		return c, err
	}
	// Legacy partial Basic configuration remains silently unverified. An explicit
	// mode opts into query validation even when its required fields are missing.
	// Read credentials never fall back to the independent write token.
	explicit := strings.TrimSpace(get("METRICS_QUERY_AUTH_MODE")) != ""
	completeLegacy := strings.TrimSpace(get("METRICS_QUERY_URL")) != "" && strings.TrimSpace(get("METRICS_USERNAME")) != "" && strings.TrimSpace(get("METRICS_QUERY_TOKEN")) != ""
	if explicit || completeLegacy {
		q, e := upstream(get, "METRICS_QUERY")
		if e != nil {
			c.QueryError = e
		} else {
			// Match the API's Prometheus base contract: no query strings.
			u, _ := url.Parse(q.URL) // upstream already validated the URL.
			if u.RawQuery != "" || u.ForceQuery {
				c.QueryError = errors.New("METRICS_QUERY_URL must not contain a query string")
			} else {
				// Accept a base or exact endpoint without double-appending;
				// URL joining preserves escaped paths.
				if !strings.HasSuffix(strings.TrimRight(u.Path, "/"), "/api/v1/query") {
					u = u.JoinPath("api/v1/query")
				}
				q.URL = u.String()
				c.Query = &q
			}
		}
	}
	return c, nil
}
func upstream(get func(string) string, prefix string) (Upstream, error) {
	var c Upstream
	mode, err := upstreamauth.ParseMode(get(prefix + "_AUTH_MODE"))
	if err != nil {
		return c, authConfigError(err, prefix)
	}
	if c.URL, err = required(get, prefix+"_URL"); err != nil {
		return c, err
	}
	if err = validateURL(c.URL, prefix+"_URL", []string{"https", "http"}, true); err != nil {
		return c, err
	}
	if c.Auth, err = upstreamauth.NewAuth(mode, get("METRICS_USERNAME"), get(prefix+"_TOKEN")); err != nil {
		return c, authConfigError(err, prefix)
	}
	seconds, err := integer(get, "REMOTE_WRITE_TIMEOUT_SECONDS", 10, 1, 120)
	if err != nil {
		return c, err
	}
	c.Timeout = time.Duration(seconds) * time.Second
	return c, nil
}

// Map only known helper fields to canonical keys; never propagate raw input or
// an upstream error into configuration diagnostics.
func authConfigError(err error, prefix string) error {
	var invalid *upstreamauth.ValidationError
	if errors.As(err, &invalid) {
		switch invalid.Field {
		case "mode":
			return fmt.Errorf("%s_AUTH_MODE must be none, basic or bearer", prefix)
		case "username":
			return errors.New("METRICS_USERNAME must be nonblank without colon or ASCII controls")
		case "token":
			return fmt.Errorf("%s_TOKEN must be nonblank and valid for the selected auth mode", prefix)
		}
	}
	return errors.New("invalid metrics authentication configuration")
}

func required(get func(string) string, name string) (string, error) {
	v := get(name)
	if strings.TrimSpace(v) == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return v, nil
}
func integer(get func(string) string, name string, def, min, max int64) (int64, error) {
	v := get(name)
	if v == "" {
		return def, nil
	}
	n, e := strconv.ParseInt(v, 10, 64)
	if e != nil || n < min || n > max {
		return 0, fmt.Errorf("%s must be an integer in [%d, %d]", name, min, max)
	}
	return n, nil
}
func validateURL(value, name string, schemes []string, upstream bool) error {
	u, e := url.Parse(value)
	valid := e == nil && u != nil && u.Hostname() != "" && u.Fragment == ""
	if valid {
		found := false
		for _, s := range schemes {
			if u.Scheme == s {
				found = true
			}
		}
		valid = found
	}
	if valid && upstream {
		valid = u.User == nil
		if u.Scheme == "http" {
			ip := net.ParseIP(u.Hostname())
			valid = valid && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback()))
		}
	}
	if !valid {
		return fmt.Errorf("%s is not a valid supported URL (metrics endpoints require HTTPS except loopback)", name)
	}
	return nil
}
