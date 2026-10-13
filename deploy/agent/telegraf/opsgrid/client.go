package opsgrid

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

// Client owns fixed-endpoint requests only. Native Telegraf outputs own metrics
// and heartbeat traffic. No scheduler, logger or credential environment bridge.
type Client struct {
	options  Options
	store    *Store
	http     *http.Client
	enrollMu sync.Mutex
}

// NewClient uses the Store's protected bootstrap pins. Explicit supplied pins
// must agree; neither remote TOML nor process environment can replace them.
func NewClient(options Options, store *Store) (*Client, error) {
	if store == nil {
		return nil, failure("STORE_REQUIRED")
	}
	if options.StateDir == "" {
		options.StateDir = store.options.StateDir
	}
	if options.APIOrigin == "" {
		options.APIOrigin = store.options.APIOrigin
	}
	if options.MetricsWriteURL == "" {
		options.MetricsWriteURL = store.options.MetricsWriteURL
	}
	o, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}
	if o.StateDir != store.options.StateDir || o.APIOrigin != store.options.APIOrigin || o.MetricsWriteURL != store.options.MetricsWriteURL {
		return nil, failure("ENDPOINT_PIN_MISMATCH")
	}
	transport := &http.Transport{
		// No proxy discovery from environment for credential-bearing control calls.
		DialContext:         (&net.Dialer{Timeout: o.Timeout}).DialContext,
		TLSHandshakeTimeout: o.Timeout, ResponseHeaderTimeout: o.Timeout,
		DisableCompression: true, MaxIdleConnsPerHost: 1, IdleConnTimeout: 30 * time.Second,
	}
	return &Client{options: o, store: store, http: &http.Client{Timeout: o.Timeout, Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (c *Client) Enroll(ctx context.Context, input EnrollmentInput) (EnrollmentResult, error) {
	c.enrollMu.Lock()
	defer c.enrollMu.Unlock()
	guard, err := c.store.lockRuntime()
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer guard.Close()
	c.store.mu.Lock()
	defer c.store.mu.Unlock()
	doc, credential, err := c.store.loadIdentity()
	defer wipe(credential)
	if err == nil {
		return EnrollmentResult{Identity: doc.Identity, Credential: string(credential), DesiredVersion: doc.DesiredVersion}, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return EnrollmentResult{}, err
	}
	return c.enroll(ctx, input, nil, false)
}

// Reenroll is operator-only: stopped native runtime plus a fresh ENR on stdin.
// It does not change Enroll's offline reuse contract and is NEVER a 401 retry.
// The enrollment server's transaction enforces the token's VM target/revocation;
// a known local identity additionally prevents switching organization or VM.
func (c *Client) Reenroll(ctx context.Context, input EnrollmentInput) (EnrollmentResult, error) {
	c.enrollMu.Lock()
	defer c.enrollMu.Unlock()
	guard, err := c.store.lockRuntime()
	if err != nil {
		return EnrollmentResult{}, err
	}
	defer guard.Close()
	c.store.mu.Lock()
	defer c.store.mu.Unlock()
	doc, credential, err := c.store.loadIdentity()
	defer wipe(credential)
	var prior *Identity
	if err == nil {
		prior = &doc.Identity
	} else if !errors.Is(err, os.ErrNotExist) {
		// Explicit recovery also handles a protected credential with no identity commit
		// (including migration residue). Do not bypass corrupt/unsafe existing identity.
		if _, identityErr := c.store.readOwned("identity.json", 8192); !errors.Is(identityErr, os.ErrNotExist) {
			return EnrollmentResult{}, err
		}
		residue, credentialErr := c.store.readOwned("agent.credential", 128)
		wipe(residue)
		if credentialErr != nil && !errors.Is(credentialErr, os.ErrNotExist) {
			return EnrollmentResult{}, credentialErr
		}
	}
	return c.enroll(ctx, input, prior, true)
}

// Caller holds both in-process and OS writer guards. No automatic token replay.
func (c *Client) enroll(ctx context.Context, input EnrollmentInput, prior *Identity, recovery bool) (EnrollmentResult, error) {
	input, err := observedEnrollment(input)
	if err != nil {
		return EnrollmentResult{}, err
	}
	body := struct {
		Token            string `json:"token"`
		Hostname         string `json:"hostname"`
		OS               string `json:"os"`
		CollectorType    string `json:"collectorType"`
		CollectorVersion string `json:"collectorVersion"`
		BuildID          string `json:"buildId"`
	}{input.Token, input.Hostname, input.OS, "TELEGRAF", input.CollectorVersion, input.BuildID}
	response, err := c.request(ctx, http.MethodPost, "/api/v1/agent-enrollment", "", "", body)
	if err != nil {
		// A lost response may follow a committed one-use token. Never automatically
		// replay it, claim a hostname or pretend enrollment is idempotent.
		return EnrollmentResult{}, failure("ENROLLMENT_RECOVERY_REQUIRED")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		return EnrollmentResult{}, statusError(response.StatusCode)
	}
	var result struct {
		OrganizationID string `json:"organizationId"`
		VMID           string `json:"vmId"`
		AgentID        string `json:"agentId"`
		Credential     string `json:"credential"`
		Status         string `json:"status"`
		DesiredVersion int64  `json:"desiredVersion"`
	}
	if err := readJSON(response, 4096, &result); err != nil {
		return EnrollmentResult{}, failure("ENROLLMENT_RECOVERY_REQUIRED")
	}
	identity := Identity{OrganizationID: result.OrganizationID, VMID: result.VMID, AgentID: result.AgentID}
	if result.Status != "ACTIVE" || !validIdentity(identity) || !validToken(result.Credential, "AGT_") || !validVersion(result.DesiredVersion) {
		return EnrollmentResult{}, failure("ENROLLMENT_RECOVERY_REQUIRED")
	}
	if prior != nil && (prior.OrganizationID != identity.OrganizationID || prior.VMID != identity.VMID) {
		return EnrollmentResult{}, failure("ENROLLMENT_TARGET_MISMATCH")
	}
	persist := c.store.saveIdentity
	if recovery {
		persist = c.store.replaceIdentity
	}
	if err := persist(identity, []byte(result.Credential), result.DesiredVersion); err != nil {
		return EnrollmentResult{}, failure("ENROLLMENT_RECOVERY_REQUIRED")
	}
	// The new agent must not reuse another identity's applied config state. Mirrors
	// may remain protected, but are never authoritative; no Alloy files are touched.
	if err := c.store.saveState(configState{}); err != nil {
		return EnrollmentResult{}, failure("ENROLLMENT_RECOVERY_REQUIRED")
	}
	return EnrollmentResult{Identity: identity, Credential: result.Credential, DesiredVersion: result.DesiredVersion}, nil
}

func (c *Client) FetchConfig(ctx context.Context, etag string) (*ConfigEnvelope, error) {
	if etag != "" {
		if !validETag(etag) {
			return nil, failure("INVALID_ETAG")
		}
		local, err := c.store.LoadCurrent()
		if err != nil {
			return nil, err
		}
		if local == nil || local.ETag() != etag {
			return nil, failure("ETAG_WITHOUT_LOCAL_STATE")
		}
	}
	_, credential, err := c.store.LoadIdentity()
	if err != nil {
		return nil, err
	}
	response, err := c.request(ctx, http.MethodGet, "/api/v1/agent/config", string(credential), etag, nil)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotModified {
		if tags := response.Header.Values("ETag"); etag == "" || len(tags) > 1 || (len(tags) == 1 && tags[0] != etag) {
			return nil, failure("INVALID_NOT_MODIFIED")
		}
		// Recheck after the request: a concurrent promotion cannot make this 304
		// validate a different local snapshot. No state writes are performed here.
		local, err := c.store.LoadCurrent()
		if err != nil {
			return nil, err
		}
		if local == nil || local.ETag() != etag {
			return nil, failure("INVALID_NOT_MODIFIED")
		}
		return nil, nil
	}
	if response.StatusCode != http.StatusOK {
		return nil, statusError(response.StatusCode)
	}
	var envelope ConfigEnvelope
	if err := readJSON(response, MaxEnvelopeBytes, &envelope); err != nil {
		return nil, err
	}
	if err := validateEnvelope(envelope); err != nil {
		return nil, err
	}
	if tags := response.Header.Values("ETag"); len(tags) > 1 || (len(tags) == 1 && tags[0] != envelope.ETag()) {
		return nil, failure("CONFIG_ETAG_MISMATCH")
	}
	return &envelope, nil
}

func (c *Client) Report(ctx context.Context, report ApplyReport) error {
	if !validVersion(report.Version) || !hashPattern.MatchString(report.Hash) || (report.Result != "applied" && report.Result != "rejected") {
		return failure("INVALID_REPORT")
	}
	// Never accept caller text, even bounded text: native errors may contain DSNs.
	report.ErrorMessage = ""
	if report.Result == "rejected" {
		if !safeReportCodes[report.ErrorCode] {
			report.ErrorCode = "CONFIG_REJECTED"
		}
	} else {
		report.ErrorCode = ""
	}
	_, credential, err := c.store.LoadIdentity()
	if err != nil {
		return err
	}
	response, err := c.request(ctx, http.MethodPost, "/api/v1/agent/config-result", string(credential), "", report)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return statusError(response.StatusCode)
	}
	return nil
}

func validETag(etag string) bool {
	parts := etagPattern.FindStringSubmatch(etag)
	if len(parts) != 3 {
		return false
	}
	version, err := strconv.ParseInt(parts[1], 10, 64)
	return err == nil && validVersion(version)
}
func (c *Client) request(ctx context.Context, method, route, credential, etag string, value any) (*http.Response, error) {
	var body io.Reader
	if value != nil {
		data, err := json.Marshal(value)
		if err != nil || len(data) > 16<<10 {
			return nil, failure("INVALID_REQUEST")
		}
		body = bytes.NewReader(data)
	}
	deadline, cancel := context.WithTimeout(ctx, c.options.Timeout)
	req, err := http.NewRequestWithContext(deadline, method, c.options.APIOrigin+route, body)
	if err != nil {
		cancel()
		return nil, failure("INVALID_REQUEST")
	}
	req.GetBody = nil // No replayable credential-bearing POST body.
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Accept-Encoding", "identity")
	req.Header.Set("Cache-Control", "no-store")
	if value != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	response, err := c.http.Do(req)
	if err != nil {
		cancel()
		return nil, failure("NETWORK_UNAVAILABLE")
	}
	// Keep the request deadline alive through body parsing, not just headers.
	response.Body = &cancelBody{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error { err := b.ReadCloser.Close(); b.cancel(); return err }
func readJSON(response *http.Response, limit int64, target any) error {
	media, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || response.ContentLength > limit {
		return failure("INVALID_RESPONSE")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return failure("NETWORK_UNAVAILABLE")
	}
	if int64(len(data)) > limit {
		return failure("RESPONSE_TOO_LARGE")
	}
	return decodeJSON(data, target)
}
func statusError(status int) error {
	code := "HTTP_REJECTED"
	switch {
	case status == http.StatusUnauthorized:
		code = "CREDENTIAL_REVOKED"
	case status >= 300 && status < 400:
		code = "REDIRECT_REJECTED"
	case status >= 500:
		code = "CONTROL_UNAVAILABLE"
	}
	return &Error{Code: code, HTTPStatus: status}
}
