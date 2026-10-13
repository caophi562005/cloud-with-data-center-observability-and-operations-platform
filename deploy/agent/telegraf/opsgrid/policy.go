package opsgrid

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/plugins/outputs/heartbeat"
	nativehttp "github.com/influxdata/telegraf/plugins/outputs/http"
	"github.com/influxdata/toml"
)

// This is a capability boundary, not a second copy of the API settings validator.
// Only keys emitted by the approved native renderer can reach plugin construction.
var inputKeys = map[string]string{
	"cpu":        "percpu totalcpu collect_cpu_time report_active core_tags",
	"mem":        "collect_extended",
	"disk":       "ignore_fs",
	"net":        "",
	"internal":   "collect_memstats collect_gostats per_instance",
	"system":     "include",
	"redis":      "servers tls_enable insecure_skip_verify tls_ca tls_cert tls_key tls_key_pwd username password",
	"postgresql": "address databases prepared_statements max_open max_idle",
	"mysql":      "servers tls_enable insecure_skip_verify tls_ca tls_cert tls_key tls_key_pwd metric_version gather_global_variables gather_process_list gather_user_statistics gather_info_schema_auto_inc gather_innodb_metrics gather_slave_status gather_replica_status gather_all_slave_channels gather_binary_logs gather_table_io_waits gather_table_lock_waits gather_index_io_waits gather_event_waits gather_table_schema gather_file_events_stats gather_perf_events_statements gather_perf_sum_per_acc_per_event",
	"nginx":      "urls tls_enable insecure_skip_verify tls_ca tls_cert tls_key tls_key_pwd timeout use_system_proxy token_url client_id client_secret",
	"docker":     "endpoint gather_services container_name_include container_name_exclude tag_env docker_label_include docker_label_exclude source_tag timeout",
}

func keysOnly(table map[string]any, keys string) bool {
	allowed := " " + keys + " "
	for key := range table {
		if !strings.Contains(allowed, " "+key+" ") {
			return false
		}
	}
	return true
}

func literalValues(value any) bool {
	switch v := value.(type) {
	case string:
		// API renderer escapes literal dollars as $$. Never resolve arbitrary process
		// environment or secret-store references in remotely supplied native config.
		return !strings.Contains(strings.ReplaceAll(v, "$$", ""), "$") && !strings.Contains(v, "@{") && !strings.Contains(v, "AGT_") && !strings.Contains(v, CredentialMarker) && !strings.Contains(v, AgentIDMarker)
	case []any:
		for _, item := range v {
			if !literalValues(item) {
				return false
			}
		}
	case map[string]any:
		for key, item := range v {
			if !literalValues(key) || !literalValues(item) {
				return false
			}
		}
	}
	return true
}

// Validate the raw output contract because Telegraf's serializer is intentionally
// private. No reflection or replacement serializer/output is used. Exact output
// tables also forbid auth overrides, TLS bypass, proxy, logs/config heartbeat,
// output filters, persistent buffers and extra credential-marker locations.
func validateDocument(data []byte, options Options) error {
	var doc map[string]any
	if toml.Unmarshal(data, &doc) != nil {
		return failure("CONFIG_PARSE_FAILED")
	}
	if len(doc) != 3 || !keysOnly(doc, "agent inputs outputs") {
		return failure("CONFIG_POLICY_REJECTED")
	}
	agentTable, ok := doc["agent"].(map[string]any)
	if !ok || !keysOnly(agentTable, "interval round_interval collection_jitter flush_interval flush_jitter metric_batch_size metric_buffer_limit omit_hostname debug") || !literalValues(agentTable) {
		return failure("CONFIG_POLICY_REJECTED")
	}
	inputs, ok := doc["inputs"].(map[string]any)
	if !ok || len(inputs) < 1 {
		return failure("CONFIG_POLICY_REJECTED")
	}
	count := 0
	for name, raw := range inputs {
		allowed, supported := inputKeys[name]
		blocks, array := raw.([]any)
		if !supported || !array || len(blocks) == 0 {
			return failure("CONFIG_POLICY_REJECTED")
		}
		for _, block := range blocks {
			table, valid := block.(map[string]any)
			if !valid || !keysOnly(table, allowed+" interval fieldpass namepass taginclude tagexclude tags") || !literalValues(table) {
				return failure("CONFIG_POLICY_REJECTED")
			}
			if insecure, exists := table["insecure_skip_verify"]; exists && insecure != false {
				return failure("CONFIG_POLICY_REJECTED")
			}
			if proxy, exists := table["use_system_proxy"]; exists && proxy != false {
				return failure("CONFIG_POLICY_REJECTED")
			}
			count++
		}
	}
	if count > 70 {
		return failure("CONFIG_POLICY_REJECTED")
	}
	expected := map[string]any{
		"http": []any{map[string]any{
			"url": options.MetricsWriteURL, "method": "POST", "data_format": "prometheusremotewrite", "prometheus_string_as_label": false,
			"use_batch_format": true, "content_encoding": "identity", "non_retryable_statuscodes": []int{400, 413, 422}, "timeout": "5s", "use_system_proxy": false,
			"headers": map[string]string{"Content-Type": "application/x-protobuf", "Content-Encoding": "snappy", "X-Prometheus-Remote-Write-Version": "0.1.0", "Authorization": "Bearer " + CredentialMarker},
		}},
		"heartbeat": []any{map[string]any{"url": options.APIOrigin + "/api/v1/agent/heartbeat", "instance_id": AgentIDMarker, "token": CredentialMarker, "interval": "60s", "include": []string{"statistics"}, "timeout": "5s", "use_system_proxy": false}},
	}
	actual, err := json.Marshal(doc["outputs"])
	want, _ := json.Marshal(expected)
	if err != nil || !bytes.Equal(actual, want) {
		return failure("CONFIG_POLICY_REJECTED")
	}
	return nil
}

func ValidatePolicy(cfg *config.Config, options Options) error {
	o, err := normalizeOptions(options)
	if err != nil || cfg == nil || cfg.Agent == nil || o.APIOrigin == "" {
		return failure("CONFIG_POLICY_REJECTED")
	}
	if len(cfg.Processors) != 0 || len(cfg.Aggregators) != 0 || len(cfg.AggProcessors) != 0 || len(cfg.SecretStores) != 0 || cfg.Persister != nil || len(cfg.Outputs) != 2 || len(cfg.Inputs) < 1 || len(cfg.Inputs) > 70 {
		return failure("CONFIG_POLICY_REJECTED")
	}
	a := cfg.Agent
	if a.Interval < config.Duration(15*time.Second) || a.Interval > config.Duration(time.Hour) || a.FlushInterval != config.Duration(30*time.Second) || a.CollectionJitter != 0 || a.FlushJitter != 0 || a.MetricBatchSize != 1000 || a.MetricBufferLimit != 10000 || !a.OmitHostname || !a.RoundInterval || a.Debug || a.Logfile != "" {
		return failure("CONFIG_POLICY_REJECTED")
	}
	for _, input := range cfg.Inputs {
		if _, ok := inputKeys[input.Config.Name]; !ok || input.Config.Interval < 15*time.Second || input.Config.Interval > time.Hour {
			return failure("CONFIG_POLICY_REJECTED")
		}
	}
	httpCount, heartbeatCount := 0, 0
	for _, output := range cfg.Outputs {
		switch p := output.Output.(type) {
		case *nativehttp.HTTP:
			httpCount++
			if output.Config.Name != "http" || p.URL != o.MetricsWriteURL || p.Method != "POST" || p.ContentEncoding != "identity" || !p.UseBatchFormat || p.InsecureSkipVerify || p.UseSystemProxy || p.HTTPProxyURL != "" || p.Timeout != config.Duration(5*time.Second) || !p.Username.Empty() || !p.Password.Empty() || len(p.Headers) != 4 || !secretEquals(p.Headers["Authorization"], "Bearer "+CredentialMarker) {
				return failure("CONFIG_POLICY_REJECTED")
			}
			for key, value := range map[string]string{"Content-Type": "application/x-protobuf", "Content-Encoding": "snappy", "X-Prometheus-Remote-Write-Version": "0.1.0"} {
				if !secretEquals(p.Headers[key], value) {
					return failure("CONFIG_POLICY_REJECTED")
				}
			}
			if len(p.NonRetryableStatusCodes) != 3 || p.NonRetryableStatusCodes[0] != 400 || p.NonRetryableStatusCodes[1] != 413 || p.NonRetryableStatusCodes[2] != 422 {
				return failure("CONFIG_POLICY_REJECTED")
			}
		case *heartbeat.Heartbeat:
			heartbeatCount++
			if output.Config.Name != "heartbeat" || !secretEquals(&p.URL, o.APIOrigin+"/api/v1/agent/heartbeat") || !secretEquals(&p.Token, CredentialMarker) || p.InstanceID != AgentIDMarker || p.Interval != config.Duration(time.Minute) || len(p.Include) != 1 || p.Include[0] != "statistics" || p.InsecureSkipVerify || p.UseSystemProxy || p.HTTPProxyURL != "" || p.Timeout != config.Duration(5*time.Second) || len(p.Headers) != 0 {
				return failure("CONFIG_POLICY_REJECTED")
			}
		default:
			return failure("CONFIG_POLICY_REJECTED")
		}
	}
	if httpCount != 1 || heartbeatCount != 1 {
		return failure("CONFIG_POLICY_REJECTED")
	}
	return nil
}
