package cache

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/auth"
	"github.com/redis/go-redis/v9"
)

const redisTestHash = "531b666a367143e6730a1ff4b897154ddede20987baaadfb0446bd19cad4c49c"
const redisTestKey = "opsgrid:agent-auth:531b666a367143e6730a1ff4b897154ddede20987baaadfb0446bd19cad4c49c"
const agentJSON = `{"agentId":"10000000-0000-4000-8000-000000000001","vmId":"20000000-0000-4000-8000-000000000002","organizationId":"30000000-0000-4000-8000-000000000003","status":"ACTIVE"}`

func redisAgent() auth.Agent {
	return auth.Agent{
		AgentID:        "10000000-0000-4000-8000-000000000001",
		VMID:           "20000000-0000-4000-8000-000000000002",
		OrganizationID: "30000000-0000-4000-8000-000000000003",
		Status:         "ACTIVE",
	}
}

// A real TCP RESP2 peer verifies our adapter's keys, payloads and expiration commands.
// It implements only handshake replies and the GET/SET boundary under test.
func respClient(t *testing.T, reply func([]string) string) (*redis.Client, <-chan []string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	commands := make(chan []string, 8)
	done := make(chan struct{})
	client := redis.NewClient(&redis.Options{
		Addr: listener.Addr().String(), Protocol: 2, DisableIdentity: true,
		MaxRetries: -1, ContextTimeoutEnabled: true,
		DialTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second,
	})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
		reader := bufio.NewReader(conn)
		for {
			command, err := readRESPCommand(reader)
			if err != nil {
				return
			}
			var response string
			switch strings.ToLower(command[0]) {
			case "hello":
				response = "-ERR unsupported HELLO\r\n"
			case "client":
				response = "+OK\r\n"
			default:
				commands <- command
				response = reply(command)
			}
			if _, err := io.WriteString(conn, response); err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		_ = client.Close()
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("RESP fixture did not stop")
		}
	})
	return client, commands
}

func readRESPCommand(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(line, "*") {
		return nil, errors.New("expected RESP array")
	}
	count, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(line, "*"), "\r\n"))
	if err != nil || count < 1 {
		return nil, errors.New("invalid RESP array length")
	}
	values := make([]string, count)
	for i := range values {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(line, "$") {
			return nil, errors.New("expected RESP bulk string")
		}
		length, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(line, "$"), "\r\n"))
		if err != nil || length < 0 {
			return nil, errors.New("invalid RESP bulk length")
		}
		payload := make([]byte, length+2)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return nil, err
		}
		values[i] = string(payload[:length])
	}
	return values, nil
}

func nextCommand(t *testing.T, commands <-chan []string) []string {
	t.Helper()
	select {
	case command := <-commands:
		return command
	case <-time.After(5 * time.Second):
		t.Fatal("adapter did not issue Redis command")
		return nil
	}
}

func TestRedisGetDecodesAgentJSONAndUsesNamespacedHashKey(t *testing.T) {
	client, commands := respClient(t, func([]string) string { return fmt.Sprintf("$%d\r\n%s\r\n", len(agentJSON), agentJSON) })
	got, found, err := NewRedis(client).Get(context.Background(), redisTestHash)
	if err != nil || !found || got != redisAgent() {
		t.Fatalf("Get = %#v, %v, %v", got, found, err)
	}
	command := nextCommand(t, commands)
	if len(command) != 2 || strings.ToLower(command[0]) != "get" || command[1] != redisTestKey {
		t.Fatalf("GET boundary = %q", command)
	}
}

func TestRedisGetNilIsCacheMiss(t *testing.T) {
	client, _ := respClient(t, func([]string) string { return "$-1\r\n" })
	got, found, err := NewRedis(client).Get(context.Background(), redisTestHash)
	if err != nil || found || got != (auth.Agent{}) {
		t.Fatalf("nil GET = %#v, %v, %v", got, found, err)
	}
}

func TestRedisGetMalformedJSONReturnsErrorAndNoPartialMetadata(t *testing.T) {
	for _, payload := range []string{"{", `{"agentId":"partial","status":123}`, `[]`} {
		t.Run(payload, func(t *testing.T) {
			client, _ := respClient(t, func([]string) string { return fmt.Sprintf("$%d\r\n%s\r\n", len(payload), payload) })
			got, found, err := NewRedis(client).Get(context.Background(), redisTestHash)
			if err == nil || found || got != (auth.Agent{}) {
				t.Fatalf("malformed GET = %#v, %v, %v", got, found, err)
			}
		})
	}
}

func TestRedisGetFailureReturnsError(t *testing.T) {
	client, _ := respClient(t, func([]string) string { return "-ERR unavailable\r\n" })
	got, found, err := NewRedis(client).Get(context.Background(), redisTestHash)
	if err == nil || found || got != (auth.Agent{}) {
		t.Fatalf("Redis failure = %#v, %v, %v", got, found, err)
	}
}

func TestRedisSetUsesSuppliedTTLAndAgentJSON(t *testing.T) {
	for _, tc := range []struct {
		name          string
		ttl           time.Duration
		option, value string
	}{
		{"seconds", 75 * time.Second, "ex", "75"},
		{"milliseconds", 1500 * time.Millisecond, "px", "1500"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, commands := respClient(t, func([]string) string { return "+OK\r\n" })
			if err := NewRedis(client).Set(context.Background(), redisTestHash, redisAgent(), tc.ttl); err != nil {
				t.Fatal(err)
			}
			command := nextCommand(t, commands)
			if len(command) != 5 || strings.ToLower(command[0]) != "set" || command[1] != redisTestKey || strings.ToLower(command[3]) != tc.option || command[4] != tc.value {
				t.Fatalf("SET boundary = %q", command)
			}
			var payload map[string]string
			if err := json.Unmarshal([]byte(command[2]), &payload); err != nil {
				t.Fatal(err)
			}
			want := map[string]string{"agentId": "10000000-0000-4000-8000-000000000001", "vmId": "20000000-0000-4000-8000-000000000002", "organizationId": "30000000-0000-4000-8000-000000000003", "status": "ACTIVE"}
			if len(payload) != len(want) {
				t.Fatalf("unexpected cached JSON fields: %v", payload)
			}
			for key, value := range want {
				if payload[key] != value {
					t.Fatalf("JSON field %q = %q, want %q", key, payload[key], value)
				}
			}
		})
	}
}

func TestRedisSetPropagatesFailure(t *testing.T) {
	client, _ := respClient(t, func([]string) string { return "-ERR unavailable\r\n" })
	if err := NewRedis(client).Set(context.Background(), redisTestHash, redisAgent(), time.Minute); err == nil {
		t.Fatal("SET error discarded")
	}
}

func TestRedisGetHonorsCanceledContext(t *testing.T) {
	client, commands := respClient(t, func([]string) string { return "$-1\r\n" })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, found, err := NewRedis(client).Get(ctx, redisTestHash)
	if err == nil || found || got != (auth.Agent{}) {
		t.Fatalf("canceled Get = %#v, %v, %v", got, found, err)
	}
	select {
	case command := <-commands:
		t.Fatalf("canceled GET reached server: %q", command)
	default:
	}
}
