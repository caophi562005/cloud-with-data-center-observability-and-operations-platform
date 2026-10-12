// Package upstream provides validated outbound HTTP authentication.
package upstream

import (
	"errors"
	"net/http"
	"strings"
)

// Mode selects the outbound Authorization scheme.
type Mode string

const (
	ModeNone   Mode = "none"
	ModeBasic  Mode = "basic"
	ModeBearer Mode = "bearer"
)

// Auth holds only the credentials required by its selected mode.
// Its zero value is invalid; construct it with NewAuth.
type Auth struct {
	mode            Mode
	username, token string
}

// ValidationError identifies the invalid field without retaining its input.
type ValidationError struct {
	Field string
}

func (e *ValidationError) Error() string {
	switch e.Field {
	case "mode":
		return "invalid auth mode: must be none, basic, or bearer"
	case "username":
		return "invalid auth username: must be nonblank without colon or ASCII controls"
	case "token":
		return "invalid auth token: must be nonblank and valid for the selected mode"
	default:
		return "invalid auth field"
	}
}

// ParseMode normalizes only the mode, defaulting absent or blank input to Basic.
func ParseMode(raw string) (Mode, error) {
	mode := Mode(strings.ToLower(strings.TrimSpace(raw)))
	switch mode {
	case "":
		return ModeBasic, nil
	case ModeNone, ModeBasic, ModeBearer:
		return mode, nil
	default:
		return "", &ValidationError{Field: "mode"}
	}
}

// NewAuth validates used credentials without trimming or repairing their bytes.
// Credentials unused by the selected mode are discarded.
func NewAuth(mode Mode, username, token string) (Auth, error) {
	switch mode {
	case ModeNone:
		return Auth{mode: mode}, nil
	case ModeBasic:
		if strings.TrimSpace(username) == "" || strings.Contains(username, ":") || hasASCIIControl(username) {
			return Auth{}, &ValidationError{Field: "username"}
		}
		if strings.TrimSpace(token) == "" || hasASCIIControl(token) {
			return Auth{}, &ValidationError{Field: "token"}
		}
		return Auth{mode: mode, username: username, token: token}, nil
	case ModeBearer:
		if token == "" {
			return Auth{}, &ValidationError{Field: "token"}
		}
		for i := 0; i < len(token); i++ {
			if token[i] < 33 || token[i] > 126 {
				return Auth{}, &ValidationError{Field: "token"}
			}
		}
		return Auth{mode: mode, token: token}, nil
	default:
		return Auth{}, &ValidationError{Field: "mode"}
	}
}

func hasASCIIControl(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 32 || value[i] == 127 {
			return true
		}
	}
	return false
}

// Mode returns the validated selection, or the invalid zero mode for zero Auth.
func (a Auth) Mode() Mode {
	return a.mode
}

// Apply replaces the logical Authorization header, including noncanonical map
// keys. Errors must be propagated by callers; they never authorize an unsigned send.
func (a Auth) Apply(req *http.Request) error {
	if _, err := NewAuth(a.mode, a.username, a.token); err != nil {
		return err
	}
	if req == nil {
		return errors.New("cannot apply auth to nil request")
	}

	// Header.Del canonicalizes its lookup but cannot remove manually stored aliases.
	for key := range req.Header {
		if strings.EqualFold(key, "Authorization") {
			delete(req.Header, key)
		}
	}
	if a.mode != ModeNone && req.Header == nil {
		req.Header = make(http.Header)
	}
	switch a.mode {
	case ModeNone:
		req.Header.Del("Authorization")
	case ModeBasic:
		req.SetBasicAuth(a.username, a.token)
	case ModeBearer:
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	return nil
}
