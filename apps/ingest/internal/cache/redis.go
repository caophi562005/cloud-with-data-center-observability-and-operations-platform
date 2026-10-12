// Package cache provides the Redis agent-auth metadata cache.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/redis/go-redis/v9"
)

type Redis struct{ client *redis.Client }

func NewRedis(client *redis.Client) *Redis { return &Redis{client: client} }

func (r *Redis) Get(ctx context.Context, hash string) (auth.Agent, bool, error) {
	value, err := r.client.Get(ctx, "opsgrid:agent-auth:"+hash).Bytes()
	if errors.Is(err, redis.Nil) {
		return auth.Agent{}, false, nil
	}
	if err != nil {
		return auth.Agent{}, false, err
	}
	var agent auth.Agent
	if err := json.Unmarshal(value, &agent); err != nil {
		// Do not return decoder errors that may echo corrupted cached data.
		return auth.Agent{}, false, errors.New("invalid cached agent JSON")
	}
	return agent, true, nil
}

func (r *Redis) Set(ctx context.Context, hash string, agent auth.Agent, ttl time.Duration) error {
	value, err := json.Marshal(agent)
	if err != nil {
		return errors.New("agent cache encoding failed")
	}
	return r.client.Set(ctx, "opsgrid:agent-auth:"+hash, value, ttl).Err()
}

var _ auth.Cache = (*Redis)(nil)
