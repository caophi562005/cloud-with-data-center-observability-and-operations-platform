package opsgrid

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/influxdata/telegraf/agent"
	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/logger"
)

// Coordinator has a single owner: the native lifecycle loop. Only one candidate
// and one failed pair/report are retained. Native outputs own metrics/heartbeat.
type Coordinator struct {
	// ReadyNotify only notifies native service status AFTER the real boundary.
	ReadyNotify                     func()
	options                         Options
	store                           *Store
	client                          *Client
	pending                         *ConfigEnvelope
	applied                         *ConfigEnvelope
	rejection                       *ApplyReport
	appliedPending, rejectedPending bool
}

func NewCoordinator(options Options, store *Store, client *Client) *Coordinator {
	return &Coordinator{options: options, store: store, client: client}
}

func samePair(a, b ConfigEnvelope) bool { return a.Version == b.Version && a.Hash == b.Hash }

func (c *Coordinator) prepare(envelope ConfigEnvelope, stage bool) (*PreparedConfig, error) {
	if err := validateEnvelope(envelope); err != nil {
		return nil, err
	}
	if err := validateDocument([]byte(envelope.TOML), c.options); err != nil {
		return nil, err
	}
	cfg := config.NewConfig()
	config.OldEnvVarReplacement = false
	if err := cfg.LoadConfigData([]byte(envelope.TOML), filepath.Join(c.options.StateDir, "candidate.toml")); err != nil {
		destroyBinding(cfg)
		return nil, failure("CONFIG_PARSE_FAILED")
	}
	if err := ValidatePolicy(cfg, c.options); err != nil {
		destroyBinding(cfg)
		return nil, err
	}
	identity, credential, err := c.store.LoadIdentity()
	if err != nil {
		destroyBinding(cfg)
		return nil, err
	}
	defer wipe(credential)
	if err := bindIdentity(cfg, identity); err != nil {
		destroyBinding(cfg)
		return nil, err
	}
	if err := BindCredential(cfg, credential); err != nil {
		destroyBinding(cfg)
		return nil, err
	}
	if stage {
		if err := c.store.Stage(envelope); err != nil {
			destroyBinding(cfg)
			return nil, err
		}
	}
	copy := envelope
	c.pending = &copy
	return &PreparedConfig{Envelope: envelope, Config: cfg}, nil
}

func (c *Coordinator) Boot(ctx context.Context) (*PreparedConfig, error) {
	if c.store == nil || c.client == nil {
		return nil, failure("COORDINATOR_INVALID")
	}
	o, err := c.store.LoadOptions()
	if err != nil {
		return nil, err
	}
	c.options = o
	current, currentErr := c.store.LoadCurrent()
	if currentErr == nil && current != nil {
		if prepared, err := c.prepare(*current, false); err == nil {
			return prepared, nil
		}
	}
	// Cold recovery only: a verified previous may replace an unusable current.
	// During candidate application current still IS the last running good snapshot.
	previous, previousErr := c.store.LoadPrevious()
	if previousErr == nil && previous != nil {
		if prepared, err := c.prepare(*previous, false); err == nil {
			if err := c.store.RestorePrevious(); err == nil {
				return prepared, nil
			}
			destroyBinding(prepared.Config)
		}
	}
	envelope, err := c.client.FetchConfig(ctx, "")
	if err != nil {
		return nil, err
	}
	if envelope == nil {
		return nil, failure("CONFIG_UNAVAILABLE")
	}
	prepared, err := c.prepare(*envelope, true)
	if err != nil {
		c.reject(ctx, *envelope, err)
		return nil, safeApplyError(err)
	}
	return prepared, nil
}

// Reports are best-effort control traffic, never collector startup dependencies.
func (c *Coordinator) retryReports(ctx context.Context) {
	if c.rejectedPending && c.rejection != nil {
		if c.client.Report(ctx, *c.rejection) == nil {
			c.rejectedPending = false
		}
	}
	if c.appliedPending && c.applied != nil {
		if c.client.Report(ctx, ApplyReport{Version: c.applied.Version, Hash: c.applied.Hash, Result: "applied"}) == nil {
			c.appliedPending = false
		}
	}
}

func (c *Coordinator) Poll(ctx context.Context) (*PreparedConfig, error) {
	c.retryReports(ctx)
	current, err := c.store.LoadCurrent()
	if err != nil {
		return nil, err
	}
	etag := ""
	if current != nil {
		etag = current.ETag()
	}
	envelope, err := c.client.FetchConfig(ctx, etag)
	if err != nil || envelope == nil {
		return nil, err
	}
	if current != nil && samePair(*current, *envelope) {
		return nil, nil
	}
	if c.rejection != nil && c.rejection.Version == envelope.Version && c.rejection.Hash == envelope.Hash {
		return nil, nil
	}
	if current != nil && envelope.Version < current.Version {
		c.reject(ctx, *envelope, failure("CONFIG_REJECTED"))
		return nil, failure("CONFIG_REJECTED")
	}
	prepared, err := c.prepare(*envelope, true)
	if err != nil {
		c.reject(ctx, *envelope, err)
		return nil, safeApplyError(err)
	}
	return prepared, nil
}

func (c *Coordinator) Started(ctx context.Context, prepared PreparedConfig) error {
	if c.pending == nil || !samePair(*c.pending, prepared.Envelope) {
		return failure("CONFIG_APPLY_FAILED")
	}
	current, err := c.store.LoadCurrent()
	if err != nil {
		return failure("CONFIG_APPLY_FAILED")
	}
	if current == nil || !samePair(*current, prepared.Envelope) {
		if err := c.store.Promote(prepared.Envelope); err != nil {
			return failure("CONFIG_APPLY_FAILED")
		}
	}
	copy := prepared.Envelope
	c.applied, c.pending, c.appliedPending = &copy, nil, true
	c.retryReports(ctx)
	return nil // ACK outage does not undo a durable native-ready local promotion.
}

func safeApplyError(err error) error {
	var problem *Error
	if errors.As(err, &problem) && safeReportCodes[problem.Code] {
		return failure(problem.Code)
	}
	return failure("CONFIG_REJECTED")
}
func (c *Coordinator) reject(ctx context.Context, envelope ConfigEnvelope, cause error) {
	code := safeApplyError(cause).(*Error).Code
	c.rejection = &ApplyReport{Version: envelope.Version, Hash: envelope.Hash, Result: "rejected", ErrorCode: code, ErrorMessage: "Configuration rejected"}
	c.rejectedPending = true
	c.retryReports(ctx)
}

func (c *Coordinator) Failed(ctx context.Context, prepared PreparedConfig, cause error) (*PreparedConfig, error) {
	c.pending = nil
	c.reject(ctx, prepared.Envelope, cause)
	current, err := c.store.LoadCurrent()
	if err == nil && current != nil && !samePair(*current, prepared.Envelope) {
		// Stage does not rotate current. Restart exactly the pre-apply current, NOT
		// blindly previous (which is two generations old before promotion).
		return c.prepare(*current, false)
	}
	previous, err := c.store.LoadPrevious()
	if err != nil || previous == nil || samePair(*previous, prepared.Envelope) {
		return nil, failure("CONFIG_START_FAILED")
	}
	fallback, err := c.prepare(*previous, false)
	if err != nil {
		return nil, err
	}
	if err := c.store.RestorePrevious(); err != nil {
		destroyBinding(fallback.Config)
		return nil, err
	}
	return fallback, nil
}

func pollDelay(base time.Duration) time.Duration {
	var data [8]byte
	if _, err := rand.Read(data[:]); err != nil {
		return base
	}
	delay := base + time.Duration(binary.LittleEndian.Uint64(data[:])%uint64(base/10+1))
	if delay > 300*time.Second {
		delay = 300 * time.Second
	}
	return delay
}

// Run is invoked by BOTH native OS startup paths. StartupReady is a tiny upstream
// hook after InitPlugins/startOutputs/startInputs, not a goroutine/service ACK.
// Cancellation waits for Agent.Run (including native output Close) before any
// fallback/reload. After readiness, collection/delivery errors are native health,
// not a reason to bounce through historical configurations.
func (c *Coordinator) Run(ctx context.Context) error {
	guard, err := c.store.lockRuntime()
	if err != nil {
		return err
	}
	defer guard.Close()
	// Native parser/plugin errors can contain DSNs, passwords or response bodies.
	// Keep native counters/heartbeat intact but suppress that untrusted log content.
	logger.RedirectLogging(io.Discard)
	prepared, err := c.Boot(ctx)
	if err != nil {
		return err
	}
	base := c.options.PollInterval
	if base < time.Second {
		base = 60 * time.Second
	}
	fallbackAttempt := false
	for {
		runCtx, cancel := context.WithCancel(ctx)
		ready := make(chan struct{}, 1)
		done := make(chan error, 1)
		native := agent.NewAgent(prepared.Config)
		native.StartupReady = func() error {
			if runCtx.Err() != nil {
				return failure("CONFIG_START_FAILED")
			}
			if err := c.Started(runCtx, *prepared); err != nil {
				return err
			}
			if c.ReadyNotify != nil {
				c.ReadyNotify()
			}
			ready <- struct{}{}
			return nil
		}
		go func() { done <- native.Run(runCtx) }()
		started := false
		select {
		case <-ready:
			started = true
		case err = <-done:
			// A very early post-boundary exit must not be misclassified as startup.
			select {
			case <-ready:
				started = true
			default:
			}
			cancel()
			destroyBinding(prepared.Config)
			if ctx.Err() != nil {
				return nil
			}
			if started {
				return failure("CONFIG_RUNTIME_STOPPED")
			}
			cause := failure("CONFIG_START_FAILED")
			var problem *Error
			if errors.As(err, &problem) && problem.Code == "CONFIG_APPLY_FAILED" {
				cause = err
			}
			if fallbackAttempt {
				c.reject(ctx, prepared.Envelope, cause)
				return cause
			}
			prepared, err = c.Failed(ctx, *prepared, cause)
			if err != nil {
				return err
			}
			fallbackAttempt = true
			continue
		}
		fallbackAttempt = false
		delay := base
		timer := time.NewTimer(pollDelay(delay))
		var next *PreparedConfig
	running:
		for {
			select {
			case <-ctx.Done():
				cancel()
				<-done
				timer.Stop()
				destroyBinding(prepared.Config)
				return nil
			case <-done:
				cancel()
				timer.Stop()
				destroyBinding(prepared.Config)
				if ctx.Err() != nil {
					return nil
				}
				return failure("CONFIG_RUNTIME_STOPPED")
			case <-timer.C:
				next, err = c.Poll(ctx)
				if err != nil {
					fmt.Fprintln(os.Stderr, safeLogError(err))
					delay *= 2
					if delay > 300*time.Second {
						delay = 300 * time.Second
					}
				} else {
					delay = base
				}
				if next != nil {
					cancel()
					<-done
					destroyBinding(prepared.Config)
					break running
				}
				timer.Reset(pollDelay(delay))
			}
		}
		timer.Stop()
		prepared = next
	}
}

// RunManaged is the thin CLI bridge; one coordinator, one native runtime.
func RunManaged(ctx context.Context, stateDir string, notify func()) error {
	store, err := NewStore(Options{StateDir: stateDir})
	if err != nil {
		return safeLogError(err)
	}
	options, err := store.LoadOptions()
	if err != nil {
		return safeLogError(err)
	}
	client, err := NewClient(options, store)
	if err != nil {
		return safeLogError(err)
	}
	coordinator := NewCoordinator(options, store, client)
	coordinator.ReadyNotify = notify
	return safeResult(coordinator.Run(ctx))
}

// Enrollment receives an operator code ONLY from bounded stdin. Ordinary valid
// identity reuse is offline and does not even consume stdin. Never logs results.
func Enrollment(ctx context.Context, options Options, stdin io.Reader, version, buildID string, recovery bool) error {
	store, err := NewStore(options)
	if err != nil {
		return safeLogError(err)
	}
	client, err := NewClient(options, store)
	if err != nil {
		return safeLogError(err)
	}
	input := EnrollmentInput{CollectorVersion: version, BuildID: buildID}
	if !recovery {
		_, credential, existing := store.LoadIdentity()
		wipe(credential)
		if existing == nil {
			_, err = client.Enroll(ctx, input)
			return safeResult(err)
		}
	}
	data, err := io.ReadAll(io.LimitReader(stdin, 257))
	if err != nil || len(data) > 256 {
		wipe(data)
		return failure("INVALID_ENROLLMENT_INPUT")
	}
	defer wipe(data)
	input.Token = strings.TrimSpace(string(data))
	if recovery {
		_, err = client.Reenroll(ctx, input)
	} else {
		_, err = client.Enroll(ctx, input)
	}
	return safeResult(err)
}

func safeResult(err error) error {
	if err == nil {
		return nil
	}
	return safeLogError(err)
}

func safeLogError(err error) error {
	var problem *Error
	if errors.As(err, &problem) {
		return problem
	}
	return failure("OPERATION_FAILED")
}
