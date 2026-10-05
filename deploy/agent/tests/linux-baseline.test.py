"""Linux baseline contract tests, using only Python stdlib.

Run: python deploy/agent/tests/linux-baseline.test.py -v
This bounded parser reads the shipped Alloy subset (blocks, scalar/list
assignments); it is NOT an Alloy validator. It rejects unmodelled relabel
operations rather than silently simulating them. Regex evaluation uses Python
re.fullmatch to model Prometheus anchored RE2 keep/drop rules. Python re is not
RE2: live Alloy syntax/regex validation remains a separate integration check.
Fixtures/expected retention are independent of the shipped allowlist. No fixed
per-host series count is asserted: CPU/device/mount cardinalities vary.
"""

import itertools
import json
from pathlib import Path
import re
import unittest

ALLOY = Path(__file__).resolve().parents[1] / "alloy"
LINUX = ALLOY / "linux.config.alloy.template"
WINDOWS = ALLOY / "windows.config.alloy.template"
COLLECTORS = [
    "cpu", "meminfo", "filesystem", "netdev", "loadavg", "stat",
    "diskstats", "vmstat", "pressure", "filefd", "timex",
]
API_NAMES = [
    "node_cpu_seconds_total", "node_memory_MemAvailable_bytes",
    "node_memory_MemTotal_bytes", "node_filesystem_avail_bytes",
    "node_filesystem_size_bytes", "node_network_receive_bytes_total",
    "node_network_transmit_bytes_total", "node_load1", "node_boot_time_seconds",
]
OPERATIONAL_NAMES = [
    "node_memory_SwapTotal_bytes", "node_memory_SwapFree_bytes",
    "node_memory_Cached_bytes", "node_memory_Buffers_bytes", "node_memory_Dirty_bytes",
    "node_vmstat_oom_kill", "node_vmstat_pgmajfault", "node_vmstat_pswpin", "node_vmstat_pswpout",
    "node_filesystem_files", "node_filesystem_files_free",
    "node_filesystem_readonly", "node_filesystem_device_error",
    "node_disk_reads_completed_total", "node_disk_writes_completed_total",
    "node_disk_read_bytes_total", "node_disk_written_bytes_total",
    "node_disk_read_time_seconds_total", "node_disk_write_time_seconds_total",
    "node_disk_io_now", "node_disk_io_time_seconds_total", "node_disk_io_time_weighted_seconds_total",
    "node_network_receive_errs_total", "node_network_transmit_errs_total",
    "node_network_receive_drop_total", "node_network_transmit_drop_total",
    "node_network_receive_packets_total", "node_network_transmit_packets_total",
    "node_load5", "node_load15", "node_procs_running", "node_procs_blocked",
    "node_pressure_cpu_waiting_seconds_total", "node_pressure_memory_waiting_seconds_total",
    "node_pressure_memory_stalled_seconds_total", "node_pressure_io_waiting_seconds_total",
    "node_pressure_io_stalled_seconds_total", "node_filefd_allocated", "node_filefd_maximum",
    "node_timex_sync_status", "node_timex_offset_seconds",
]
SCRAPE_NAMES = [
    "up", "scrape_duration_seconds", "scrape_samples_scraped",
    "scrape_samples_post_metric_relabeling", "scrape_series_added",
]
DIAGNOSTIC_NAMES = ["node_scrape_collector_success", "node_scrape_collector_duration_seconds"]
FILESYSTEM_NAMES = [name for name in API_NAMES + OPERATIONAL_NAMES if name.startswith("node_filesystem_")]
NETWORK_NAMES = [name for name in API_NAMES + OPERATIONAL_NAMES if name.startswith("node_network_")]


def parse_alloy(source):
    """Parse only the non-executable configuration subset used by these templates."""
    token = re.compile(r'\s+|//[^\n]*|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z_0-9.]*|[{}\[\]=,]')
    tokens = []
    position = 0
    while position < len(source):
        match = token.match(source, position)
        if not match:
            raise AssertionError(f"Unsupported Alloy syntax at {position}: {source[position:position + 30]!r}")
        text = match.group()
        position = match.end()
        if not text.isspace() and not text.startswith("//"):
            tokens.append(text)
    cursor = 0

    def pop():
        nonlocal cursor
        if cursor >= len(tokens):
            raise AssertionError("Unexpected end of Alloy")
        value = tokens[cursor]
        cursor += 1
        return value

    def expect(value):
        actual = pop()
        if actual != value:
            raise AssertionError(f"Expected {value!r}, got {actual!r}")

    def value():
        text = pop()
        if text == "[":
            result = []
            while tokens[cursor] != "]":
                result.append(value())
                if tokens[cursor] != "]":
                    expect(",")
            expect("]")
            return result
        if text.startswith('"'):
            return json.loads(text)
        if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9.]*", text):
            raise AssertionError(f"Unsupported Alloy value: {text}")
        return text

    def block(kind):
        label = json.loads(pop()) if tokens[cursor].startswith('"') else None
        expect("{")
        attrs, children = {}, []
        while tokens[cursor] != "}":
            key = pop()
            if tokens[cursor] == "=":
                expect("=")
                if key in attrs:
                    raise AssertionError(f"Duplicate attribute: {key}")
                attrs[key] = value()
            else:
                children.append(block(key))
        expect("}")
        return {"kind": kind, "label": label, "attrs": attrs, "children": children}

    result = []
    while cursor < len(tokens):
        result.append(block(pop()))
    return result


def component(config, kind, label):
    matches = [item for item in config if item["kind"] == kind and item["label"] == label]
    if len(matches) != 1:
        raise AssertionError(f"Expected exactly one {kind} {label!r}, found {len(matches)}")
    return matches[0]


def rules(config):
    relabels = [item for item in config if item["kind"] == "prometheus.relabel"]
    if not relabels:
        return []  # Existing direct-to-remote pipeline retains everything: honest RED.
    if len(relabels) != 1:
        raise AssertionError("Only one Linux profile relabel stage is supported")
    result = []
    for rule in relabels[0]["children"]:
        if rule["kind"] != "rule" or rule["label"] is not None or rule["children"]:
            raise AssertionError("Unsupported relabel block")
        attrs = rule["attrs"]
        if set(attrs) - {"source_labels", "separator", "regex", "action"}:
            raise AssertionError("Unsupported label transformation: dimensions must be preserved")
        if attrs.get("action") not in {"keep", "drop"}:
            raise AssertionError("Only keep/drop filtering is permitted; no label mutation")
        if not isinstance(attrs.get("source_labels"), list) or "regex" not in attrs:
            raise AssertionError("Explicit regex and source_labels required")
        # The shipped patterns need neither Python-only groups nor backreferences.
        if "(?" in attrs["regex"] or re.search(r"\\[1-9]", attrs["regex"]):
            raise AssertionError("Unsupported regex outside bounded RE2-compatible subset")
        re.compile(attrs["regex"])
        result.append(attrs)
    return result


def apply_rules(config, labels):
    for rule in rules(config):
        joined = rule.get("separator", ";").join(labels.get(name, "") for name in rule["source_labels"])
        matches = re.fullmatch(rule["regex"], joined) is not None
        if (rule["action"] == "keep" and not matches) or (rule["action"] == "drop" and matches):
            return None
    return labels.copy()


class LinuxBaselineTests(unittest.TestCase):
    def setUp(self):
        self.source = LINUX.read_text(encoding="utf-8")
        self.config = parse_alloy(self.source)

    def assert_retention(self, name, keep=True, **dimensions):
        labels = {"__name__": name, "instance": "host-a:12345", "job": "host", **dimensions}
        actual = apply_rules(self.config, labels)
        self.assertEqual(actual, labels if keep else None, f"Unexpected retention/dimension mutation: {labels}")

    def test_profile_selects_exact_collectors_and_30_second_scrape(self):
        # Catches restoring exporter defaults, enabling extra collectors, or 15s cadence.
        exporter = component(self.config, "prometheus.exporter.unix", "host")
        self.assertEqual(exporter["attrs"].get("set_collectors"), COLLECTORS)
        self.assertEqual(set(exporter["attrs"]), {"set_collectors"})
        self.assertEqual(exporter["children"], [])
        self.assertEqual(component(self.config, "prometheus.scrape", "host")["attrs"].get("scrape_interval"), "30s")
        self.assertEqual(self.source.count("// opsgrid.metrics_profile = linux-baseline-v1"), 1)

    def test_scrape_flows_through_profile_before_remote_write(self):
        # A correct but disconnected allowlist must not pass.
        scrape = component(self.config, "prometheus.scrape", "host")
        self.assertEqual(scrape["attrs"]["targets"], "prometheus.exporter.unix.host.targets")
        relabels = [item for item in self.config if item["kind"] == "prometheus.relabel"]
        self.assertEqual(len(relabels), 1, "Linux scrape needs a relabel stage")
        relabel = relabels[0]
        self.assertEqual(scrape["attrs"]["forward_to"], [f"prometheus.relabel.{relabel['label']}.receiver"])
        self.assertEqual(relabel["attrs"], {"forward_to": ["prometheus.remote_write.ingestion.receiver"]})
        self.assertGreater(len(rules(self.config)), 0)
        self.assertEqual(sorted(item["kind"] for item in self.config), sorted([
            "local.file", "prometheus.exporter.unix", "prometheus.scrape",
            "prometheus.relabel", "prometheus.remote_write",
        ]))
        self.assertEqual(scrape["children"], [])  # No hidden metric/target relabel bypass.

    def test_api_families_keep_all_cpu_modes_and_dimensions(self):
        # Catches name renaming, CPU idle-only filtering, dimension loss, or aggregation.
        for cpu, mode in itertools.product(["0", "1", "7"], [
            "user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guest_nice",
        ]):
            with self.subTest(cpu=cpu, mode=mode):
                self.assert_retention("node_cpu_seconds_total", cpu=cpu, mode=mode, tenant="fixture")
        for name in API_NAMES[1:]:
            for device, mountpoint in [("/dev/sda1", "/"), ("/dev/nvme0n1p2", "/data")]:
                with self.subTest(name=name, device=device):
                    self.assert_retention(name, device=device, mountpoint=mountpoint, fstype="ext4", arbitrary="preserve")

    def test_all_operational_names_keep_identity_and_device_dimensions(self):
        for name, device in itertools.product(OPERATIONAL_NAMES, ["sda", "nvme0n1", "eth0", "ens192"]):
            with self.subTest(name=name, device=device):
                self.assert_retention(name, device=device, mountpoint="/data", fstype="xfs", custom="unaltered")

    def test_scrape_health_names_survive_without_collector_label(self):
        for name in SCRAPE_NAMES:
            with self.subTest(name=name):
                self.assert_retention(name, fstype="tmpfs", mountpoint="/run", device="lo")

    def test_diagnostics_keep_only_selected_collectors(self):
        for name, collector in itertools.product(DIAGNOSTIC_NAMES, COLLECTORS):
            with self.subTest(name=name, collector=collector):
                self.assert_retention(name, collector=collector, extra="preserve")
        for name, collector in itertools.product(DIAGNOSTIC_NAMES, [
            "", "processes", "systemd", "textfile", "cpu_extra", "xcpu", "windows_cpu",
        ]):
            with self.subTest(name=name, collector=collector):
                self.assert_retention(name, keep=False, collector=collector)
        for name in DIAGNOSTIC_NAMES:
            self.assert_retention(name, keep=False)

    def test_unknown_and_windows_families_drop_in_linux_profile(self):
        for name in [
            "node_uname_info", "node_memory_MemFree_bytes", "node_disk_info",
            "node_network_receive_compressed_total", "node_pressure_cpu_stalled_seconds_total",
            "node_scrape_collector_duration_seconds_extra", "scrape_timeout_seconds", "unknown_metric",
            "windows_cpu_time_total", "windows_memory_available_bytes", "windows_os_physical_memory_free_bytes",
            "node_cpu_seconds_total_extra", "xnode_cpu_seconds_total", "node_load10", "up_extra",
        ]:
            with self.subTest(name=name):
                self.assert_retention(name, keep=False, collector="cpu")

    def test_filesystem_type_exclusion_exact_boundaries(self):
        for name, fstype in itertools.product(FILESYSTEM_NAMES, [
            "tmpfs", "devtmpfs", "proc", "sysfs", "overlay", "squashfs", "nsfs", "tracefs", "cgroup", "cgroup2",
        ]):
            with self.subTest(name=name, fstype=fstype):
                self.assert_retention(name, keep=False, fstype=fstype, mountpoint="/data", device="/dev/sda1")
        for name, fstype in itertools.product(FILESYSTEM_NAMES, [
            "ext4", "xfs", "btrfs", "nfs", "", "xtmpfs", "tmpfs-extra", "overlayfs", "cgroup20", "cgroup3",
        ]):
            with self.subTest(name=name, fstype=fstype):
                self.assert_retention(name, fstype=fstype, mountpoint="/data", device="/dev/sda1")

    def test_filesystem_mount_exclusion_exact_boundaries(self):
        for name, mountpoint in itertools.product(FILESYSTEM_NAMES, [
            "/run", "/run/", "/run/user/1000", "/var/lib/docker", "/var/lib/docker/overlay2/a",
            "/var/lib/containers", "/var/lib/containers/storage",
        ]):
            with self.subTest(name=name, mountpoint=mountpoint):
                self.assert_retention(name, keep=False, mountpoint=mountpoint, fstype="ext4")
        for name, mountpoint in itertools.product(FILESYSTEM_NAMES, [
            "/", "/data", "/runtime", "/runaway", "/var/lib/docker-data", "/var/lib/containers-old",
            "/var/lib/container", "/var/lib/dockerish/a", "/home/run", "",
        ]):
            with self.subTest(name=name, mountpoint=mountpoint):
                self.assert_retention(name, mountpoint=mountpoint, fstype="ext4")

    def test_filesystem_exclusions_are_not_global_label_filters(self):
        for name in API_NAMES + OPERATIONAL_NAMES + SCRAPE_NAMES:
            if name not in FILESYSTEM_NAMES:
                with self.subTest(name=name):
                    self.assert_retention(name, fstype="tmpfs", mountpoint="/run", device="eth0")
        for name in DIAGNOSTIC_NAMES:
            self.assert_retention(name, collector="cpu", fstype="overlay", mountpoint="/var/lib/docker")

    def test_loopback_exclusion_is_exact_and_network_scoped(self):
        for name in NETWORK_NAMES:
            self.assert_retention(name, keep=False, device="lo")
            for device in ["eth0", "ens192", "docker0", "veth123", "lo0", "lo-extra", "xlo", ""]:
                with self.subTest(name=name, device=device):
                    self.assert_retention(name, device=device)
        for name in API_NAMES + OPERATIONAL_NAMES + SCRAPE_NAMES:
            if name not in NETWORK_NAMES:
                self.assert_retention(name, device="lo", mountpoint="/data", fstype="ext4")
        for name in DIAGNOSTIC_NAMES:
            self.assert_retention(name, device="lo", collector="netdev")

    def test_placeholders_render_to_credential_and_gateway_once(self):
        for placeholder in ["__CREDENTIAL_FILE__", "__GATEWAY_URL__"]:
            self.assertEqual(self.source.count(placeholder), 1)
        rendered = parse_alloy(self.source.replace("__CREDENTIAL_FILE__", "/etc/opsgrid/agent-credential")
                               .replace("__GATEWAY_URL__", "https://gateway.example/api/v1/write"))
        credential = component(rendered, "local.file", "agent_credential")
        self.assertEqual(credential["attrs"], {"filename": "/etc/opsgrid/agent-credential", "is_secret": "true"})
        remote = component(rendered, "prometheus.remote_write", "ingestion")
        self.assertEqual(remote["attrs"], {})
        self.assertEqual(len(remote["children"]), 1)
        endpoint = remote["children"][0]
        self.assertEqual(endpoint["kind"], "endpoint")
        self.assertEqual(endpoint["attrs"], {"url": "https://gateway.example/api/v1/write"})
        self.assertEqual(endpoint["children"], [{
            "kind": "authorization", "label": None, "attrs": {
                "type": "Bearer", "credentials": "local.file.agent_credential.content",
            }, "children": [],
        }])

    def test_linux_filter_is_not_applied_to_windows_profile(self):
        source = WINDOWS.read_text(encoding="utf-8")
        config = parse_alloy(source)
        component(config, "prometheus.exporter.windows", "host")
        self.assertEqual(component(config, "prometheus.scrape", "host")["attrs"]["forward_to"],
                         ["prometheus.remote_write.ingestion.receiver"])
        self.assertNotIn("opsgrid.metrics_profile = linux-baseline-v1", source)
        self.assertEqual(rules(config), [])
        labels = {"__name__": "windows_cpu_time_total", "core": "0", "mode": "idle"}
        self.assertEqual(apply_rules(config, labels), labels)


if __name__ == "__main__":
    unittest.main()
