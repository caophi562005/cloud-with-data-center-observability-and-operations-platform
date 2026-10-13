package opsgrid

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Store is a single-service-writer store. Its mutex serializes in-process writes;
// it is not an interprocess lock or a revision database. Protected parents exclude
// unprivileged path replacement. Administrators/root remain trusted.
type Store struct {
	options Options
	mu      sync.Mutex
}

func NewStore(options Options) (*Store, error) {
	o, err := normalizeOptions(options)
	if err != nil {
		return nil, err
	}
	s := &Store{options: o}
	if err := s.ensureDirectory(); err != nil {
		return nil, err
	}
	if o.APIOrigin == "" {
		// Service startup can supply just an absolute StateDir. Only protected,
		// validated committed identity metadata may provide the bootstrap endpoints.
		data, err := s.readOwned("identity.json", 8192)
		if err != nil {
			return nil, err
		}
		var doc identityDocument
		if decodeJSON(data, &doc) != nil {
			return nil, failure("IDENTITY_INVALID")
		}
		o.APIOrigin, o.MetricsWriteURL = doc.APIOrigin, doc.MetricsWriteURL
		o, err = normalizeOptions(o)
		if err != nil || o.APIOrigin == "" {
			return nil, failure("IDENTITY_INVALID")
		}
		s.options = o
		if _, _, err := s.loadIdentity(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// LoadOptions returns validated persisted pins, never remote TOML values. The
// service may use NewStore(Options{StateDir: ...}) without endpoint flags or env.
func (s *Store) LoadOptions() (Options, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, _, err := s.loadIdentity(); err != nil {
		return Options{}, err
	}
	return s.options, nil
}

// lockRuntime is an OS-held, nonblocking writer guard, not a PID/lease framework.
// It is released by closing the handle (including on process death); the empty
// protected lock file stays in place so there is no unlink/recreate lock race.
func (s *Store) lockRuntime() (*os.File, error) {
	if err := s.checkDirectory(); err != nil {
		return nil, err
	}
	path := filepath.Join(s.options.StateDir, "runtime.lock")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err == nil {
		if err = platformProtectFile(path); err != nil {
			file.Close()
			return nil, err
		}
	} else if errors.Is(err, os.ErrExist) {
		info, statErr := os.Lstat(path)
		if statErr != nil || platformValidate(path, info, false, false) != nil {
			return nil, failure("UNSAFE_RUNTIME_LOCK")
		}
		file, err = os.OpenFile(path, os.O_RDWR, 0)
	}
	if err != nil {
		return nil, failure("RUNTIME_LOCK_FAILED")
	}
	if err := platformLock(file); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

// Full envelopes in this one atomic commit record are authoritative. TOML files
// are protected native-load mirrors, not independent commits. This bounded three
// snapshot record permits repair of a torn multi-file operation without history,
// a journal, outside temps or trusting a mismatched TOML/version/hash pair.
type configState struct {
	SchemaVersion int             `json:"schemaVersion"`
	AgentID       string          `json:"agentId"`
	Current       *ConfigEnvelope `json:"current"`
	Candidate     *ConfigEnvelope `json:"candidate"`
	Previous      *ConfigEnvelope `json:"previous"`
}

const maxStateBytes = 3*MaxEnvelopeBytes + 4096

func (s *Store) LoadCurrent() (*ConfigEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.readState()
	if err != nil {
		return nil, err
	}
	if state.Current == nil {
		return nil, nil
	}
	if err := validateEnvelope(*state.Current); err != nil {
		return nil, err
	}
	// An interrupted Promote may have changed the TOML mirror but not the commit
	// record. Restore only the owned mirror from the verified authoritative bytes.
	if err := s.materialize("current.toml", state.Current); err != nil {
		return nil, err
	}
	copy := *state.Current
	return &copy, nil
}
func (s *Store) Stage(candidate ConfigEnvelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateEnvelope(candidate); err != nil {
		return err
	}
	state, err := s.loadState()
	if err != nil {
		return err
	}
	if state.Current != nil && candidate.Version < state.Current.Version {
		return failure("CONFIG_VERSION_STALE")
	}
	if err := s.writeOwned("candidate.toml", []byte(candidate.TOML)); err != nil {
		return err
	}
	state.Candidate = &candidate
	return s.saveState(state) // Interrupted staging never writes current/previous.
}
func (s *Store) Promote(candidate ConfigEnvelope) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validateEnvelope(candidate); err != nil {
		return err
	}
	state, err := s.loadState()
	if err != nil {
		return err
	}
	if state.Candidate == nil || *state.Candidate != candidate {
		return failure("CANDIDATE_NOT_STAGED")
	}
	if state.Current != nil && *state.Current == candidate {
		state.Candidate = nil
		return s.saveState(state) // Idempotent promotion retains the rollback snapshot.
	}
	if state.Current != nil && candidate.Version < state.Current.Version {
		return failure("CONFIG_VERSION_STALE")
	}
	// The caller MUST have crossed actual Telegraf startup readiness before this
	// call. Parsing/staging alone never makes a candidate last-known-good.
	state.Previous = state.Current
	state.Current, state.Candidate = &candidate, nil
	if err := s.materialize("previous.toml", state.Previous); err != nil {
		return err
	}
	if err := s.materialize("current.toml", state.Current); err != nil {
		return err
	}
	return s.saveState(state) // One same-filesystem atomic metadata commit.
}
func (s *Store) LoadPrevious() (*ConfigEnvelope, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.readState()
	if err != nil {
		return nil, err
	}
	if state.Previous == nil {
		return nil, nil
	}
	if err := validateEnvelope(*state.Previous); err != nil {
		return nil, err
	}
	copy := *state.Previous
	return &copy, nil
}

func (s *Store) RestorePrevious() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := s.readState()
	if err != nil {
		return err
	}
	if state.Previous == nil {
		return failure("PREVIOUS_CONFIG_UNAVAILABLE")
	}
	if err := validateEnvelope(*state.Previous); err != nil {
		return err
	}
	copy := *state.Previous
	state.Current, state.Candidate = &copy, nil
	if err := s.materialize("current.toml", state.Current); err != nil {
		return err
	}
	// Retain the last good previous; never turn the failed candidate into previous.
	return s.saveState(state)
}
func (s *Store) loadState() (configState, error) {
	state, err := s.readState()
	if err != nil {
		return state, err
	}
	for _, envelope := range []*ConfigEnvelope{state.Current, state.Candidate, state.Previous} {
		if envelope != nil {
			if err := validateEnvelope(*envelope); err != nil {
				return configState{}, err
			}
		}
	}
	return state, nil
}

// Recovery must validate the selected snapshot, not let an invalid unused
// candidate/previous prevent booting a verified current. Never trusts raw mirrors.
func (s *Store) readState() (configState, error) {
	state := configState{SchemaVersion: 1}
	if err := s.checkDirectory(); err != nil {
		return state, err
	}
	data, err := s.readOwned("config-state.json", maxStateBytes)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if decodeJSON(data, &state) != nil || state.SchemaVersion != 1 {
		return configState{}, failure("CONFIG_STATE_INVALID")
	}
	doc, _, err := s.loadIdentity()
	if err != nil {
		return configState{}, err
	}
	if state.AgentID != doc.Identity.AgentID {
		return configState{}, failure("CONFIG_IDENTITY_MISMATCH")
	}
	return state, nil
}
func (s *Store) saveState(state configState) error {
	doc, _, err := s.loadIdentity()
	if err != nil {
		return err
	}
	state.SchemaVersion, state.AgentID = 1, doc.Identity.AgentID
	return s.writeJSON("config-state.json", state)
}
func (s *Store) materialize(name string, envelope *ConfigEnvelope) error {
	if envelope == nil {
		return nil
	}
	data, err := s.readOwned(name, MaxEnvelopeBytes)
	if err == nil && string(data) == envelope.TOML {
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return s.writeOwned(name, []byte(envelope.TOML))
}
func (s *Store) writeJSON(name string, value any) error {
	data, err := encodeJSON(value)
	if err != nil || len(data) > maxStateBytes {
		return failure("STATE_INVALID")
	}
	return s.writeOwned(name, data)
}
func ownedName(name string) bool {
	switch name {
	case "identity.json", "agent.credential", "config-state.json", "current.toml", "candidate.toml", "previous.toml":
		return true
	default:
		return false
	}
}
func (s *Store) readOwned(name string, limit int64) ([]byte, error) {
	if !ownedName(name) {
		return nil, failure("UNOWNED_STATE_PATH")
	}
	path := filepath.Join(s.options.StateDir, name)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, os.ErrNotExist
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, failure("UNSAFE_STATE_FILE")
	}
	if err := platformValidate(path, info, false, false); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, failure("STATE_READ_FAILED")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, failure("UNSAFE_STATE_FILE")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return nil, failure("STATE_READ_FAILED")
	}
	return data, nil
}
func (s *Store) writeOwned(name string, data []byte) error {
	if !ownedName(name) {
		return failure("UNOWNED_STATE_PATH")
	}
	if err := s.checkDirectory(); err != nil {
		return err
	}
	target := filepath.Join(s.options.StateDir, name)
	if err := s.checkTarget(target); err != nil {
		return err
	}
	temp, err := os.CreateTemp(s.options.StateDir, ".opsgrid-write-*")
	if err != nil {
		return failure("STATE_WRITE_FAILED")
	}
	tempPath := temp.Name()
	// Cleanup is limited to this call's exclusively-created temp, never existing
	// user/state files or recursive directories. A killed process can leave a
	// protected orphan; startup does not run broad cleanup/deletion machinery.
	defer func() { temp.Close(); _ = os.Remove(tempPath) }()
	if err := platformProtectFile(tempPath); err != nil {
		return err
	}
	if _, err := temp.Write(data); err != nil {
		return failure("STATE_WRITE_FAILED")
	}
	if err := temp.Sync(); err != nil {
		return failure("STATE_SYNC_FAILED")
	}
	if err := temp.Close(); err != nil {
		return failure("STATE_WRITE_FAILED")
	}
	if err := s.checkDirectory(); err != nil {
		return err
	}
	if err := s.checkTarget(target); err != nil {
		return err
	}
	if err := platformReplace(tempPath, target); err != nil {
		return failure("STATE_REPLACE_FAILED")
	}
	return platformSyncDirectory(s.options.StateDir)
}
func (s *Store) checkTarget(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return failure("UNSAFE_STATE_FILE")
	}
	return platformValidate(path, info, false, false)
}
func (s *Store) ensureDirectory() error {
	dir := s.options.StateDir
	parent := filepath.Dir(dir)
	// Do not create a chain of unprotected directories or tighten user directories.
	// The selected immediate parent must already exist and be trusted.
	if err := validateParents(parent); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		if err := platformCreateDirectory(dir); err != nil {
			return failure("STATE_DIRECTORY_CREATE_FAILED")
		}
	} else if err != nil || !info.IsDir() {
		return failure("UNSAFE_STATE_DIRECTORY")
	}
	return s.checkDirectory()
}
func (s *Store) checkDirectory() error {
	if err := validateParents(filepath.Dir(s.options.StateDir)); err != nil {
		return err
	}
	info, err := os.Lstat(s.options.StateDir)
	if err != nil || !info.IsDir() {
		return failure("UNSAFE_STATE_DIRECTORY")
	}
	if err := platformValidate(s.options.StateDir, info, true, false); err != nil {
		return err
	}
	for _, name := range []string{"identity.json", "agent.credential", "config-state.json", "current.toml", "candidate.toml", "previous.toml"} {
		if err := s.checkTarget(filepath.Join(s.options.StateDir, name)); err != nil {
			return err
		}
	}
	return nil
}
func validateParents(path string) error {
	for {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() {
			return failure("UNSAFE_STATE_PARENT")
		}
		if err := platformValidate(path, info, true, true); err != nil {
			return err
		}
		next := filepath.Dir(path)
		if next == path {
			return nil
		}
		path = next
	}
}
