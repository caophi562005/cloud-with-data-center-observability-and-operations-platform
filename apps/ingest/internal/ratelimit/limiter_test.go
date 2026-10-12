package ratelimit

import (
	"testing"
	"time"
)

// Detects IP/global limiting, burst resets and concurrent map access.
func TestPerAgentBurstAndRefill(t *testing.T) {
	l := New(1, 2)
	now := time.Now()
	if !l.allowAt("a", now) || !l.allowAt("a", now) || l.allowAt("a", now) {
		t.Fatal("burst not enforced")
	}
	if !l.allowAt("b", now) {
		t.Fatal("different agent shares depleted bucket")
	}
	if !l.allowAt("a", now.Add(time.Second)) {
		t.Fatal("no refill")
	}
}
func TestIdleBucketsEvicted(t *testing.T) {
	l := New(1, 1)
	now := time.Now()
	l.allowAt("old", now)
	l.allowAt("new", now.Add(11*time.Minute))
	if _, ok := l.entries["old"]; ok {
		t.Fatal("idle bucket leaked")
	}
}
func TestCleanupDoesNotResetSlowBucket(t *testing.T) {
	l := New(0.0001, 1)
	now := time.Now()
	if !l.allowAt("slow", now) {
		t.Fatal("first request blocked")
	}
	l.allowAt("other", now.Add(11*time.Minute))
	if l.allowAt("slow", now.Add(11*time.Minute)) {
		t.Fatal("cleanup reset depleted slow bucket")
	}
}
func TestConcurrentAllow(t *testing.T) {
	l := New(5, 20)
	done := make(chan bool, 40)
	for i := 0; i < 40; i++ {
		go func() { done <- l.Allow("same-agent") }()
	}
	n := 0
	for i := 0; i < 40; i++ {
		if <-done {
			n++
		}
	}
	if n != 20 {
		t.Fatalf("burst allowed %d", n)
	}
}
