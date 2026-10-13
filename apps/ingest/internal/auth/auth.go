// Package auth validates agent bearer credentials without exposing plaintext to dependencies.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"time"
)

type Agent struct {
	AgentID        string `json:"agentId"`
	VMID           string `json:"vmId"`
	OrganizationID string `json:"organizationId"`
	Status         string `json:"status"`
}

var (
	ErrUnauthorized = errors.New("unauthorized")
	ErrUnavailable  = errors.New("authentication unavailable")
	ErrNotFound     = errors.New("agent not found")
)

type Repository interface {
	FindByTokenHash(context.Context, string) (Agent, error)
}

type Cache interface {
	Get(context.Context, string) (Agent, bool, error)
	Set(context.Context, string, Agent, time.Duration) error
}

type Service struct {
	repo   Repository
	cache  Cache
	ttl    time.Duration
	logger *slog.Logger
}

func NewService(repo Repository, cache Cache, ttl time.Duration, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{repo: repo, cache: cache, ttl: ttl, logger: logger}
}

func (s *Service) Authenticate(ctx context.Context, authorization string) (Agent, error) {
	token, err := ParseBearer(authorization)
	if err != nil {
		return Agent{}, ErrUnauthorized
	}
	hash := HashToken(token)
	if s.cache != nil {
		cacheCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		agent, found, cacheErr := s.cache.Get(cacheCtx, hash)
		cancel()
		if cacheErr != nil {
			// Dependency errors can contain connection credentials or key material.
			s.logger.WarnContext(ctx, "agent authentication cache read failed")
		} else if found {
			if !validAgent(agent) {
				return Agent{}, ErrUnauthorized
			}
			return agent, nil
		}
	}

	dbCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	agent, err := s.repo.FindByTokenHash(dbCtx, hash)
	cancel()
	if errors.Is(err, ErrNotFound) {
		return Agent{}, ErrUnauthorized
	}
	if err != nil {
		return Agent{}, ErrUnavailable
	}
	if !validAgent(agent) {
		return Agent{}, ErrUnauthorized
	}
	if s.cache != nil {
		cacheCtx, cancel := context.WithTimeout(ctx, 250*time.Millisecond)
		err := s.cache.Set(cacheCtx, hash, agent, s.ttl)
		cancel()
		if err != nil {
			s.logger.WarnContext(ctx, "agent authentication cache write failed")
		}
	}
	return agent, nil
}

// HashToken matches Node's SHA-256 of the complete, unmodified UTF-8 credential.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ParseBearer accepts one ASCII space and RFC 6750 token characters only.
func ParseBearer(header string) (string, error) {
	scheme, token, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || !strings.HasPrefix(token, "AGT_") || len(token) == len("AGT_") {
		return "", ErrUnauthorized
	}
	padding := false
	for i := 0; i < len(token); i++ {
		c := token[i]
		if c == '=' {
			padding = true
			continue
		}
		if padding || !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-._~+/", rune(c))) {
			return "", ErrUnauthorized
		}
	}
	return token, nil
}

func validAgent(agent Agent) bool {
	return agent.Status == "ACTIVE" && validUUID(agent.AgentID) && validUUID(agent.VMID) && validUUID(agent.OrganizationID)
}

// PostgreSQL's UUID-to-text projection has this fixed shape. Do not repair metadata.
func validUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}
