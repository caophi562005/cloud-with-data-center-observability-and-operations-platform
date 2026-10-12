// Image smoke fixture/client. Synthetic credentials and IDs belong only to the
// disposable local DB/cache. Never point this harness at production services.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/golang/snappy"
	"github.com/prometheus/prometheus/prompb"
)

const token = "AGT_local_image_smoke_only"
const agent = "11111111-1111-4111-8111-111111111111"
const vm = "22222222-2222-4222-8222-222222222222"
const org = "33333333-3333-4333-8333-333333333333"

type report struct {
	Count      int
	Labels     []prompb.Label
	Samples    []prompb.Sample
	BasicOK    bool
	ProtocolOK bool
}

var client = &http.Client{Timeout: 10 * time.Second}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		serve()
		return
	}
	if len(os.Args) != 4 {
		panic("usage: image-smoke MODE GATEWAY_URL FIXTURE_URL")
	}
	if err := verify(os.Args[1], os.Args[2], os.Args[3]); err != nil {
		fmt.Fprintln(os.Stderr, "FAIL:", err)
		os.Exit(1)
	}
}
func serve() {
	var mu sync.Mutex
	state := report{}
	status := 204
	write := http.NewServeMux()
	write.HandleFunc("/api/v1/write", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
		if err != nil {
			w.WriteHeader(400)
			return
		}
		decoded, err := snappy.Decode(nil, body)
		if err != nil {
			w.WriteHeader(400)
			return
		}
		var req prompb.WriteRequest
		if req.Unmarshal(decoded) != nil || len(req.Timeseries) != 1 {
			w.WriteHeader(400)
			return
		}
		user, password, ok := r.BasicAuth()
		mu.Lock()
		defer mu.Unlock()
		state.Count++
		state.Labels = req.Timeseries[0].Labels
		state.Samples = req.Timeseries[0].Samples
		state.BasicOK = ok && user == "local-smoke-user" && password == "local-smoke-password"
		state.ProtocolOK = r.Header.Get("Content-Type") == "application/x-protobuf" && r.Header.Get("Content-Encoding") == "snappy" && r.Header.Get("X-Prometheus-Remote-Write-Version") == "0.1.0"
		w.Header().Set("Retry-After", "3")
		w.WriteHeader(status)
	})
	admin := http.NewServeMux()
	admin.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	admin.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_ = json.NewEncoder(w).Encode(state)
	})
	admin.HandleFunc("/control", func(w http.ResponseWriter, r *http.Request) {
		n, err := strconv.Atoi(r.URL.Query().Get("status"))
		if err != nil || n < 200 || n > 599 {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		status = n
		mu.Unlock()
		w.WriteHeader(204)
	})
	go func() {
		if err := http.ListenAndServe(":19091", write); err != nil {
			panic(err)
		}
	}()
	if err := http.ListenAndServe(":19092", admin); err != nil {
		panic(err)
	}
}
func payload() []byte {
	req := prompb.WriteRequest{Timeseries: []prompb.TimeSeries{{Labels: []prompb.Label{
		{Name: "__name__", Value: "opsgrid_local_image_smoke"}, {Name: "source", Value: "local-fixture"},
		{Name: "agent_id", Value: "spoof"}, {Name: "agent_id", Value: "duplicate-spoof"},
		{Name: "vm_id", Value: "spoof"}, {Name: "organization_id", Value: "spoof"},
	}, Samples: []prompb.Sample{{Value: 1, Timestamp: time.Now().UnixMilli()}}}}}
	raw, err := req.Marshal()
	if err != nil {
		panic(err)
	}
	return snappy.Encode(nil, raw)
}
func request(method, url, credential string, body []byte, protocol bool) (int, http.Header, error) {
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}
	if protocol {
		req.Header.Set("Content-Type", "application/x-protobuf")
		req.Header.Set("Content-Encoding", "snappy")
		req.Header.Set("X-Prometheus-Remote-Write-Version", "0.1.0")
	} else {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.Header.Get("X-Request-ID") == "" && credential != "control" && method != "GET" {
		return 0, nil, fmt.Errorf("missing request ID")
	}
	return response.StatusCode, response.Header, nil
}
func check(label, method, url, credential string, body []byte, protocol bool, expected int) error {
	status, _, err := request(method, url, credential, body, protocol)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	if status != expected {
		return fmt.Errorf("%s: got %d, expected %d", label, status, expected)
	}
	fmt.Printf("PASS %s: HTTP %d\n", label, status)
	return nil
}
func control(url string, status int) error {
	return check("fixture status", "GET", fmt.Sprintf("%s/control?status=%d", url, status), "control", nil, false, 204)
}
func inspect(url string) error {
	response, err := client.Get(url + "/stats")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var state report
	if err = json.NewDecoder(response.Body).Decode(&state); err != nil {
		return err
	}
	expected := map[string]string{"__name__": "opsgrid_local_image_smoke", "source": "local-fixture", "agent_id": agent, "vm_id": vm, "organization_id": org}
	if state.Count < 1 || !state.BasicOK || !state.ProtocolOK || len(state.Labels) != len(expected) || len(state.Samples) != 1 || state.Samples[0].Value != 1 {
		return fmt.Errorf("forwarded payload/headers mismatch")
	}
	if !sort.SliceIsSorted(state.Labels, func(i, j int) bool { return state.Labels[i].Name < state.Labels[j].Name }) {
		return fmt.Errorf("labels not sorted")
	}
	for _, label := range state.Labels {
		if expected[label.Name] != label.Value {
			return fmt.Errorf("trusted-label overwrite failed")
		}
		delete(expected, label.Name)
	}
	if len(expected) != 0 {
		return fmt.Errorf("missing labels")
	}
	fmt.Println("PASS forwarded Snappy/protobuf, Basic Auth, sample and trusted identity-label overwrite")
	return nil
}
func verify(mode, base, upstream string) error {
	write := base + "/api/v1/write"
	if mode == "functional" {
		for _, item := range []struct {
			label, method, path, credential string
			body                            []byte
			protocol                        bool
			status                          int
		}{
			{"liveness", "GET", "/health", "", nil, false, 200}, {"readiness", "GET", "/ready", "", nil, false, 200},
			{"missing bearer", "POST", "/api/v1/write", "", payload(), true, 401},
			{"unknown local credential", "POST", "/api/v1/write", "AGT_unknown_local_fixture", payload(), true, 401},
			{"revoked fixture credential", "POST", "/api/v1/write", "AGT_revoked_local_fixture", payload(), true, 401},
			{"wrong protocol", "POST", "/api/v1/write", token, payload(), false, 400},
			{"malformed snappy", "POST", "/api/v1/write", token, []byte("invalid"), true, 400},
			{"valid fixture write", "POST", "/api/v1/write", token, payload(), true, 204},
		} {
			if err := check(item.label, item.method, base+item.path, item.credential, item.body, item.protocol, item.status); err != nil {
				return err
			}
		}
		if err := inspect(upstream); err != nil {
			return err
		}
		if err := control(upstream, 500); err != nil {
			return err
		}
		if err := check("upstream 500 not acknowledged", "POST", write, token, payload(), true, 502); err != nil {
			return err
		}
		if err := control(upstream, 429); err != nil {
			return err
		}
		status, headers, err := request("POST", write, token, payload(), true)
		if err != nil || status != 429 || headers.Get("Retry-After") != "3" {
			return fmt.Errorf("upstream rate-limit propagation failed: HTTP %d", status)
		}
		fmt.Println("PASS upstream 429 with Retry-After=3")
		if err := control(upstream, 204); err != nil {
			return err
		}
		return check("oversize body", "POST", write, token, bytes.Repeat([]byte("x"), 2049), true, 413)
	}
	if mode == "cached" {
		if err := check("liveness with DB paused", "GET", base+"/health", "", nil, false, 200); err != nil {
			return err
		}
		if err := check("readiness with DB paused", "GET", base+"/ready", "", nil, false, 503); err != nil {
			return err
		}
		if err := check("cached identity with DB paused", "POST", write, token, payload(), true, 204); err != nil {
			return err
		}
		if err := check("cache miss with DB paused", "POST", write, "AGT_uncached_local_fixture", payload(), true, 503); err != nil {
			return err
		}
		return inspect(upstream)
	}
	if mode == "fallback" {
		if err := check("ready despite Redis outage", "GET", base+"/ready", "", nil, false, 200); err != nil {
			return err
		}
		if err := check("Redis outage DB fallback", "POST", write, token, payload(), true, 204); err != nil {
			return err
		}
		return inspect(upstream)
	}
	if mode == "unavailable" {
		return check("both auth dependencies unavailable", "POST", write, token, payload(), true, 503)
	}
	if mode == "rate" {
		for i := 0; i < 25; i++ {
			status, headers, err := request("POST", write, token, payload(), true)
			if err != nil {
				return err
			}
			if status == 429 {
				if headers.Get("Retry-After") != "1" {
					return fmt.Errorf("missing local rate Retry-After")
				}
				fmt.Printf("PASS per-agent rate limit after %d requests: HTTP 429\n", i+1)
				return nil
			}
			if status != 204 {
				return fmt.Errorf("rate setup returned HTTP %d", status)
			}
		}
		return fmt.Errorf("rate limit never triggered")
	}
	return fmt.Errorf("unknown test mode")
}
