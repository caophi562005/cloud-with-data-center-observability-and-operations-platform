// Package ratelimit provides a process-local token bucket per authenticated agent.
package ratelimit

import (
	"golang.org/x/time/rate"
	"sync"
	"time"
)

type entry struct {
	bucket   *rate.Limiter
	lastSeen time.Time
}
type Limiter struct {
	mu          sync.Mutex
	entries     map[string]*entry
	rps         rate.Limit
	burst       int
	idleTTL     time.Duration
	nextCleanup time.Time
}

func New(rps float64, burst int) *Limiter {
	// An idle entry may be removed only after its bucket could have fully refilled.
	idle := 10 * time.Minute
	refill := time.Duration(float64(burst) / rps * float64(time.Second))
	if refill > idle {
		idle = refill + time.Minute
	}
	return &Limiter{entries: make(map[string]*entry), rps: rate.Limit(rps), burst: burst, idleTTL: idle}
}
func (l *Limiter) Allow(agentID string) bool { return l.allowAt(agentID, time.Now()) }
func (l *Limiter) allowAt(agentID string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !now.Before(l.nextCleanup) {
		for key, e := range l.entries {
			if now.Sub(e.lastSeen) > l.idleTTL {
				delete(l.entries, key)
			}
		}
		l.nextCleanup = now.Add(time.Minute)
	}
	e := l.entries[agentID]
	if e == nil {
		e = &entry{bucket: rate.NewLimiter(l.rps, l.burst)}
		l.entries[agentID] = e
	}
	e.lastSeen = now
	return e.bucket.AllowN(now, 1)
}
