// Package opsgrid provides the protected control-plane foundation embedded in Telegraf.
// Runtime coordination and native credential binding belong to the lifecycle overlay.
package opsgrid

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/influxdata/telegraf/config"
)

const (
	MaxEnvelopeBytes       = 256 << 10
	CredentialMarker       = "__OPSGRID_AGENT_CREDENTIAL__"
	AgentIDMarker          = "__OPSGRID_AGENT_ID__"
	maxVersion       int64 = 2147483647
	requestTimeout         = 5 * time.Second
)

type Identity struct {
	OrganizationID string `json:"organizationId"`
	VMID           string `json:"vmId"`
	AgentID        string `json:"agentId"`
}
type EnrollmentInput struct{ Token, Hostname, OS, CollectorVersion, BuildID string }
type EnrollmentResult struct {
	Identity       Identity
	Credential     string
	DesiredVersion int64
}
type ConfigEnvelope struct {
	SchemaVersion int    `json:"schemaVersion"`
	Version       int64  `json:"version"`
	Hash          string `json:"hash"`
	ProfileKey    string `json:"profileKey"`
	TOML          string `json:"toml"`
}
type ApplyReport struct {
	Version      int64  `json:"version"`
	Hash         string `json:"hash"`
	Result       string `json:"result"`
	ErrorCode    string `json:"errorCode,omitempty"`
	ErrorMessage string `json:"errorMessage,omitempty"`
}
type PreparedConfig struct {
	Envelope ConfigEnvelope
	Config   *config.Config
}
type Options struct {
	StateDir, APIOrigin, MetricsWriteURL string
	PollInterval, Timeout                time.Duration
}

// Error is deliberately cause/body-free: callers may safely print Error(), never
// HTTP payloads, URL errors, native parser errors or credential bytes.
type Error struct {
	Code       string
	HTTPStatus int
}

func (e *Error) Error() string  { return "[opsgrid-agent] " + e.Code }
func failure(code string) error { return &Error{Code: code} }

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var etagPattern = regexp.MustCompile(`^"([1-9][0-9]{0,9})-([0-9a-f]{64})"$`)

func validVersion(v int64) bool       { return v >= 1 && v <= maxVersion }
func (e ConfigEnvelope) ETag() string { return fmt.Sprintf(`"%d-%s"`, e.Version, e.Hash) }
func validateEnvelope(e ConfigEnvelope) error {
	if e.SchemaVersion != 1 {
		return failure("CONFIG_SCHEMA_UNSUPPORTED")
	}
	if !validVersion(e.Version) || e.ProfileKey != "telegraf-native-v1" || !hashPattern.MatchString(e.Hash) || e.TOML == "" || !utf8.ValidString(e.TOML) {
		return failure("CONFIG_INVALID")
	}
	sum := sha256.Sum256([]byte(e.TOML))
	if hex.EncodeToString(sum[:]) != e.Hash {
		return failure("CONFIG_HASH_MISMATCH")
	}
	b, err := encodeJSON(e)
	if err != nil || len(b) > MaxEnvelopeBytes {
		return failure("CONFIG_TOO_LARGE")
	}
	return nil
}

// Use the API's JSON representation without HTML escaping; DSNs and secrets may
// contain <, > or &, and escaping those again needlessly inflates a bounded cache.
func encodeJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

// Only one complete strict JSON object is accepted; a second value or arbitrary
// trailing bytes are not silently discarded. Inputs are byte-bounded beforehand.
func decodeJSON(data []byte, target any) error {
	if !utf8.Valid(data) {
		return failure("INVALID_RESPONSE")
	}
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return failure("INVALID_RESPONSE")
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return failure("INVALID_RESPONSE")
	}
	return nil
}

var safeReportCodes = map[string]bool{
	"CONFIG_HASH_MISMATCH": true, "CONFIG_SCHEMA_UNSUPPORTED": true,
	"CONFIG_POLICY_REJECTED": true, "CONFIG_PARSE_FAILED": true,
	"CONFIG_START_FAILED": true, "CONFIG_APPLY_FAILED": true, "CONFIG_REJECTED": true,
}
