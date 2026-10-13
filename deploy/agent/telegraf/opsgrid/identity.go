package opsgrid

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var hostnamePattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$`)
var buildPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`)

func validIdentity(i Identity) bool {
	return uuidPattern.MatchString(i.OrganizationID) && uuidPattern.MatchString(i.VMID) && uuidPattern.MatchString(i.AgentID)
}
func validToken(value, prefix string) bool {
	if len(value) != len(prefix)+43 || !strings.HasPrefix(value, prefix) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(value[len(prefix):])
	return err == nil && len(raw) == 32 && base64.RawURLEncoding.EncodeToString(raw) == value[len(prefix):]
}

func normalizeOptions(o Options) (Options, error) {
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		return o, failure("UNSUPPORTED_OS")
	}
	if o.StateDir == "" {
		o.StateDir = defaultStateDir
	}
	if !filepath.IsAbs(o.StateDir) || filepath.Clean(o.StateDir) == filepath.VolumeName(o.StateDir)+string(filepath.Separator) {
		return o, failure("INVALID_STATE_DIRECTORY")
	}
	o.StateDir = filepath.Clean(o.StateDir)
	// UNC/device paths would put protected state on a remote share or bypass normal
	// parent checks. This implementation supports local absolute state only.
	if runtime.GOOS == "windows" && (strings.HasPrefix(o.StateDir, `\\`) || strings.Contains(o.StateDir[2:], ":")) {
		return o, failure("INVALID_STATE_DIRECTORY")
	}
	if o.APIOrigin != "" || o.MetricsWriteURL != "" {
		api, err := validateEndpoint(o.APIOrigin, true)
		if err != nil {
			return o, err
		}
		metrics, err := validateEndpoint(o.MetricsWriteURL, false)
		if err != nil {
			return o, err
		}
		o.APIOrigin, o.MetricsWriteURL = api, metrics
	}
	if o.Timeout < 0 || o.PollInterval < 0 {
		return o, failure("INVALID_OPTIONS")
	}
	if o.Timeout == 0 || o.Timeout > requestTimeout {
		o.Timeout = requestTimeout
	}
	return o, nil
}

func validateEndpoint(raw string, originOnly bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawFragment != "" || strings.Contains(raw, "#") || u.Opaque != "" {
		return "", failure("INVALID_ENDPOINT")
	}
	if originOnly {
		if u.Path != "" && u.Path != "/" {
			return "", failure("INVALID_ENDPOINT")
		}
		if u.RawPath != "" {
			return "", failure("INVALID_ENDPOINT")
		}
		u.Path = ""
	} else if u.Path == "" || u.Path == "/" {
		return "", failure("INVALID_ENDPOINT")
	}
	canonical := u.String()
	if len(canonical) > 2048 {
		return "", failure("INVALID_ENDPOINT")
	}
	return canonical, nil
}

// Inventory is observed locally; caller-provided hostname/OS, if supplied, must
// match. Organization/VM authority never enters an enrollment request.
func observedEnrollment(input EnrollmentInput) (EnrollmentInput, error) {
	host, err := os.Hostname()
	if err != nil {
		return input, failure("HOSTNAME_UNAVAILABLE")
	}
	host = strings.ToLower(strings.TrimSpace(host))
	if len(host) < 1 || len(host) > 253 || !hostnamePattern.MatchString(host) ||
		(input.Hostname != "" && input.Hostname != host) || (input.OS != "" && input.OS != runtime.GOOS) ||
		(runtime.GOOS != "linux" && runtime.GOOS != "windows") {
		return input, failure("INVALID_INVENTORY")
	}
	if !validToken(input.Token, "ENR_") || len(input.CollectorVersion) > 128 || len(input.BuildID) > 128 ||
		!buildPattern.MatchString(input.CollectorVersion) || !buildPattern.MatchString(input.BuildID) {
		return input, failure("INVALID_ENROLLMENT_INPUT")
	}
	input.Hostname, input.OS = host, runtime.GOOS
	return input, nil
}

type identityDocument struct {
	SchemaVersion   int      `json:"schemaVersion"`
	Identity        Identity `json:"identity"`
	CredentialHash  string   `json:"credentialHash"`
	APIOrigin       string   `json:"apiOrigin"`
	MetricsWriteURL string   `json:"metricsWriteUrl"`
	DesiredVersion  int64    `json:"desiredVersion"`
}

func credentialHash(credential []byte) string {
	h := sha256.Sum256(credential)
	return hex.EncodeToString(h[:])
}

func (s *Store) LoadIdentity() (Identity, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, credential, err := s.loadIdentity()
	return doc.Identity, credential, err
}
func (s *Store) loadIdentity() (identityDocument, []byte, error) {
	var doc identityDocument
	if err := s.checkDirectory(); err != nil {
		return doc, nil, err
	}
	data, err := s.readOwned("identity.json", 8192)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// A credential without its identity commit is not fresh enrollment state.
			if _, probe := s.readOwned("agent.credential", 128); !errors.Is(probe, os.ErrNotExist) {
				return doc, nil, failure("IDENTITY_RECOVERY_REQUIRED")
			}
		}
		return doc, nil, err
	}
	if decodeJSON(data, &doc) != nil || doc.SchemaVersion != 1 || !validIdentity(doc.Identity) || !hashPattern.MatchString(doc.CredentialHash) || !validVersion(doc.DesiredVersion) {
		return identityDocument{}, nil, failure("IDENTITY_INVALID")
	}
	if doc.APIOrigin != s.options.APIOrigin || doc.MetricsWriteURL != s.options.MetricsWriteURL {
		return identityDocument{}, nil, failure("ENDPOINT_PIN_MISMATCH")
	}
	credential, err := s.readOwned("agent.credential", 128)
	if err != nil || !validToken(string(credential), "AGT_") || credentialHash(credential) != doc.CredentialHash {
		return identityDocument{}, nil, failure("IDENTITY_RECOVERY_REQUIRED")
	}
	return doc, credential, nil
}

func (s *Store) SaveIdentity(identity Identity, credential []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveIdentity(identity, credential, 1)
}
func (s *Store) saveIdentity(identity Identity, credential []byte, desired int64) error {
	if !validIdentity(identity) || !validToken(string(credential), "AGT_") || !validVersion(desired) {
		return failure("IDENTITY_INVALID")
	}
	if err := s.checkDirectory(); err != nil {
		return err
	}
	doc, old, err := s.loadIdentity()
	if err == nil {
		if doc.Identity != identity || string(old) != string(credential) {
			return failure("IDENTITY_RECOVERY_REQUIRED")
		}
		return nil // Never silently replace a valid machine identity or its pins.
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return s.replaceIdentity(identity, credential, desired)
}

// Only the explicit operator recovery path may replace an existing identity,
// after the server accepted a VM-bound token and the caller checked local target.
func (s *Store) replaceIdentity(identity Identity, credential []byte, desired int64) error {
	if !validIdentity(identity) || !validToken(string(credential), "AGT_") || !validVersion(desired) {
		return failure("IDENTITY_INVALID")
	}
	if err := s.checkDirectory(); err != nil {
		return err
	}
	doc := identityDocument{SchemaVersion: 1, Identity: identity, CredentialHash: credentialHash(credential), APIOrigin: s.options.APIOrigin, MetricsWriteURL: s.options.MetricsWriteURL, DesiredVersion: desired}
	if err := s.writeOwned("agent.credential", credential); err != nil {
		return err
	}
	// Identity is the commit marker for the two-file pair. Interrupted credential
	// persistence fails closed to explicit recovery, not hostname-based enrollment.
	return s.writeJSON("identity.json", doc)
}
