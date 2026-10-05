"""Windows compact v1 contract tests (stdlib only, no live operations).

Run: python deploy/agent/tests/windows-baseline.test.py -v
Reuse the Linux suite's bounded Alloy parser/filter simulator via importlib,
without running its tests or writing bytecode. Python fullmatch models anchored
Prometheus RE2 keep/drop for this restricted subset, NOT actual Alloy validation.
Expected names/predicates below are independent of the shipped profile/manifest.
Windows-only recognition invokes real installer functions against temp fixtures;
it never invokes installer entrypoint, enrollment, SCM, ACL or a real credential.
"""

import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ALLOY = HERE.parent / "alloy"
PROFILE = ALLOY / "windows-baseline-v1.config.alloy.template"
ORIGINAL = ALLOY / "windows.config.alloy.template"
LINUX = ALLOY / "linux.config.alloy.template"
MANIFEST = HERE / "fixtures" / "windows-manifest-v1.json"
INSTALLER = HERE.parent / "install.ps1"
spec = importlib.util.spec_from_file_location("linux_baseline_utilities", HERE / "linux-baseline.test.py")
utilities = importlib.util.module_from_spec(spec)
spec.loader.exec_module(utilities)
parse_alloy, component, rules = utilities.parse_alloy, utilities.component, utilities.rules


def apply_rules(config, labels):
    """Linux simulator logic with Prometheus NewRegexp's DOTALL semantics.

    Attribution: linux-baseline.test.py:158–164. Prometheus wraps expressions as
    ^(?s:...)$; fullmatch plus DOTALL models that without extending the accepted
    regex subset. https://github.com/prometheus/prometheus/blob/main/model/relabel/relabel.go
    """
    for rule in rules(config):
        joined = rule.get("separator", ";").join(labels.get(name, "") for name in rule["source_labels"])
        matches = re.fullmatch(rule["regex"], joined, flags=re.DOTALL) is not None
        if (rule["action"] == "keep" and not matches) or (rule["action"] == "drop" and matches):
            return None
    return labels.copy()

COLLECTORS = ["cpu", "logical_disk", "memory", "net", "os", "system"]
CPU = "windows_cpu_time_total"
DISKS = ["windows_logical_disk_free_bytes", "windows_logical_disk_size_bytes"]
NETWORK = ["windows_net_bytes_received_total", "windows_net_bytes_sent_total"]
SCALARS = ["windows_memory_available_bytes", "windows_memory_physical_total_bytes", "windows_system_boot_time_timestamp"]
METRICS = [CPU, *SCALARS[:2], *DISKS, *NETWORK, SCALARS[-1]]
DIAGNOSTICS = [
    "up", "windows_exporter_build_info", "windows_exporter_collector_success",
    "windows_exporter_collector_timeout", "windows_exporter_collector_duration_seconds",
    "windows_exporter_scrape_duration_seconds", "scrape_duration_seconds",
    "scrape_samples_scraped", "scrape_samples_post_metric_relabeling", "scrape_series_added",
]
ORIGINAL_SHA = "23639cceab569f4d8392ae8d0b8046a5125068e484d18aadb1aabf22383aa16c"
LINUX_SHA = "0ad5d11a7e09eb89eda7409eab6cd58e1c3f7b92a49f12fef4e1bf0f18f4a4b6"
PROPOSAL_SHA = "bcd92c713db8e1120b1df98e55f3a2701415cbc575177b6a2c006493c25eac60"


def expected(labels):
    """Independent approved contract, not inferred from the profile's regex."""
    name = labels.get("__name__", "")
    if name in SCALARS + DIAGNOSTICS:
        return True
    if name == CPU:
        return labels.get("mode") == "idle" and re.fullmatch(r"[0-9]+,[0-9]+", labels.get("core", "")) is not None
    if name in DISKS:
        return re.fullmatch(r"[A-Za-z]:", labels.get("volume", "")) is not None
    if name in NETWORK:
        nic = labels.get("nic", "")
        return bool(nic) and re.fullmatch(r"Software Loopback Interface( [0-9]+)?", nic) is None
    return False


class WindowsBaselineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global INSTALLER, ALLOY, PROFILE, ORIGINAL, LINUX
        provided = os.environ.get("OPSGRID_TEST_RELEASE_DIR", "").strip()
        if provided:
            bundle_root = Path(provided).resolve()
            options = ["--verify", "--output", str(bundle_root)]
        else:
            cls.bundle = tempfile.TemporaryDirectory(prefix="opsgrid-windows-bundle-")
            cls.addClassCleanup(cls.bundle.cleanup)
            bundle_root = Path(cls.bundle.name)
            options = ["--output", str(bundle_root)]
        built = subprocess.run([shutil.which("node") or "node", str(HERE.parent / "build-release.mjs"),
                                *options], capture_output=True, text=True, timeout=60)
        if built.returncode:
            raise AssertionError("release build or verification failed: " + built.stderr)
        INSTALLER = bundle_root / "install.ps1"
        ALLOY = bundle_root / "alloy"
        PROFILE = ALLOY / "windows-baseline-v1.config.alloy.template"
        ORIGINAL = ALLOY / "windows.config.alloy.template"
        LINUX = ALLOY / "linux.config.alloy.template"

    def setUp(self):
        self.assertTrue(PROFILE.is_file(), "approved windows-baseline-v1 profile is missing (intended RED)")
        self.source = PROFILE.read_text(encoding="utf-8")
        self.config = parse_alloy(self.source)

    def check(self, name, keep=True, **labels):
        sample = {"__name__": name, "organization_id": "org-fixture", "vm_id": "vm-fixture",
                  "agent_id": "agent-fixture", "instance": "fixture:12345", "job": "host", **labels}
        actual = apply_rules(self.config, sample)
        self.assertEqual(actual, sample if keep else None, sample)
        if actual is not None:
            self.assertIsNot(actual, sample)

    def test_exact_components_collectors_cadence_and_pipeline(self):
        self.assertEqual([(c["kind"], c["label"]) for c in self.config], [
            ("local.file", "agent_credential"), ("prometheus.exporter.windows", "host"),
            ("prometheus.scrape", "host"), ("prometheus.relabel", "windows_baseline_v1"),
            ("prometheus.remote_write", "ingestion")])
        self.assertEqual(component(self.config, "prometheus.exporter.windows", "host"),
                         component(parse_alloy(ORIGINAL.read_text()), "prometheus.exporter.windows", "host"))
        self.assertEqual(component(self.config, "prometheus.exporter.windows", "host")["attrs"],
                         {"enabled_collectors": COLLECTORS})
        self.assertEqual(component(self.config, "prometheus.scrape", "host")["attrs"], {
            "targets": "prometheus.exporter.windows.host.targets",
            "forward_to": ["prometheus.relabel.windows_baseline_v1.receiver"], "scrape_interval": "15s"})
        self.assertEqual(component(self.config, "prometheus.relabel", "windows_baseline_v1")["attrs"],
                         {"forward_to": ["prometheus.remote_write.ingestion.receiver"]})

    def test_exact_gateway_secret_reference_and_one_writer(self):
        original = parse_alloy(ORIGINAL.read_text())
        for kind, label in [("local.file", "agent_credential"), ("prometheus.remote_write", "ingestion")]:
            self.assertEqual(component(self.config, kind, label), component(original, kind, label))
        self.assertEqual(self.source.count("__CREDENTIAL_FILE__"), 1)
        self.assertEqual(component(self.config, "local.file", "agent_credential")["attrs"],
                         {"filename": "__CREDENTIAL_FILE__", "is_secret": "true"})
        auth = component(self.config, "prometheus.remote_write", "ingestion")["children"][0]["children"]
        self.assertEqual(auth[0]["attrs"], {"type": "Bearer", "credentials": "local.file.agent_credential.content"})
        rendered = self.source.replace("__CREDENTIAL_FILE__", "C:/fixture-only/agent-credential.jwt")
        self.assertEqual(component(parse_alloy(rendered), "local.file", "agent_credential")["attrs"]["filename"],
                         "C:/fixture-only/agent-credential.jwt")

    def test_rules_are_anchored_bounded_re2_filter_only(self):
        filtered = rules(self.config)
        self.assertEqual(len(filtered), 4)
        self.assertEqual([r["action"] for r in filtered], ["keep", "keep", "keep", "drop"])
        for r in filtered:
            self.assertTrue(r["regex"].startswith("^") and r["regex"].endswith("$"))
            self.assertEqual(r.get("separator", ";"), ";")
            self.assertNotIn("(?", r["regex"])
            self.assertTrue(set(r["source_labels"]) <= {"__name__", "mode", "core", "volume", "nic"})
            self.assertEqual(len(r["source_labels"]), len(set(r["source_labels"])))
        self.assertNotIn("__tmp", self.source)
        self.assertNotIn("labeldrop", self.source)
        self.assertNotIn("labelkeep", self.source)

    def test_all_eight_native_inputs_retained(self):
        self.check(CPU, mode="idle", core="0,1")
        for name in SCALARS:
            self.check(name)
        for name in DISKS:
            self.check(name, volume="C:")
        for name in NETWORK:
            self.check(name, nic="Ethernet 2")

    def test_all_ten_diagnostics_all_collectors_and_labels_survive(self):
        for name in DIAGNOSTICS:
            for collector in [*COLLECTORS, "future_collector", ""]:
                with self.subTest(name=name, collector=collector):
                    self.check(name, collector=collector, mode="user", core="_Total", volume="HarddiskVolume1",
                               nic="Software Loopback Interface 1", version="fixture", revision="abc", arbitrary="a;b")

    def test_cpu_exact_mode_core_missing_and_boundaries(self):
        for core in ["0,0", "0,1", "1,42", "123,999", "00,01"]:
            self.check(CPU, core=core, mode="idle")
        for core in ["", "0", "_Total", "0,_Total", "_Total,0", "-1,0", "0,1x", "x0,1", "0,1,2", "0,1\n", " 0,1", "０,１"]:
            self.check(CPU, False, core=core, mode="idle")
        for mode in ["", "user", "system", "Idle", "idleX", "xidle", "idle\n"]:
            self.check(CPU, False, core="0,1", mode=mode)
        self.check(CPU, False, mode="idle")
        self.check(CPU, False, core="0,1")
        self.check(CPU, False)

    def test_volume_letters_only_missing_and_boundaries(self):
        for name in DISKS:
            for volume in ["C:", "D:", "Z:", "a:"]:
                self.check(name, volume=volume)
            for volume in ["", "C", "C:\\", "CC:", "1:", "C:extra", "xC:", " C:", "C:\n", "_Total", "HarddiskVolume1", "Volume{abc}", "é:"]:
                self.check(name, False, volume=volume)
            self.check(name, False)

    def test_nic_nonempty_dynamic_and_exact_loopback_exclusion(self):
        for name in NETWORK:
            for nic in ["Ethernet", "Ethernet 17", "vEthernet (new adapter)", "新网卡", "lo", "Loopback",
                        "Software Loopback Interface X", "xSoftware Loopback Interface", "Software Loopback Interface 1x", "nic\n"]:
                self.check(name, nic=nic)
            for nic in ["", "Software Loopback Interface", "Software Loopback Interface 1", "Software Loopback Interface 42"]:
                self.check(name, False, nic=nic)
            self.check(name, False)

    def test_exact_names_prefix_suffix_and_unknowns_dropped(self):
        for name in METRICS + DIAGNOSTICS:
            for unknown in ["prefix_" + name, name + "_suffix", name + "\n", name.upper()]:
                self.check(unknown, False, mode="idle", core="0,0", volume="C:", nic="Ethernet")
        for name in ["", "node_load1", "node_cpu_seconds_total", "windows_cpu_processor_performance",
                     "windows_logical_disk_read_bytes_total", "windows_net_packets_received_total", "windows_os_info",
                     "windows_exporter_unapproved", "scrape_unapproved"]:
            self.check(name, False, mode="idle", core="0,0", volume="C:", nic="Ethernet")
        self.assertIsNone(apply_rules(self.config, {"core": "0,0", "mode": "idle"}))

    def test_device_predicates_are_family_scoped(self):
        for name in SCALARS + DIAGNOSTICS:
            self.check(name)
            self.check(name, core="bad;core", mode="nonidle;mode", volume="bad;volume",
                       nic="Software Loopback Interface 1", arbitrary="unchanged")
            self.check(name, core="bad\ncore", mode="user\nmode", volume="bad\nvolume", nic="loop\nback")
        self.check(CPU, core="12,37", mode="idle", volume="bad;volume", nic="Software Loopback Interface 1")
        for name in DISKS:
            self.check(name, volume="d:", core="bad;core", mode="nonidle", nic="Software Loopback Interface 1")
        for name in NETWORK:
            self.check(name, nic="Ethernet", core="bad;core", mode="user", volume="bad;volume")

    def test_dynamic_topology_not_fixed_enumeration(self):
        for core in ["0,0", "0,1", "7,63", "123,999"]:
            self.check(CPU, core=core, mode="idle")
        for name in DISKS:
            for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz":
                self.check(name, volume=letter + ":")
        for name in NETWORK:
            for n in range(1, 13):
                self.check(name, nic=f"new adapter {n}")

    def test_independent_cartesian_predicate_oracle(self):
        for name, mode, core, volume, nic in itertools.product(
            METRICS + DIAGNOSTICS + ["unknown"], [None, "idle", "user"], [None, "0,0", "_Total"],
            [None, "C:", "HarddiskVolume1"], [None, "Ethernet", "Software Loopback Interface 1"]
        ):
            labels = {"__name__": name, "instance": "fixture", "collector": "os", "identity": "unchanged"}
            labels.update({k: v for k, v in [("mode", mode), ("core", core), ("volume", volume), ("nic", nic)] if v is not None})
            self.assertEqual(apply_rules(self.config, labels), labels if expected(labels) else None, labels)

    def test_manifest_contract_and_observed_projection_not_after_claim(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["profile"], "windows-baseline-v1")
        self.assertEqual(manifest["metricFamilies"], METRICS)
        self.assertEqual(manifest["diagnosticFamilies"], DIAGNOSTICS)
        self.assertEqual(manifest["collectors"], COLLECTORS)
        self.assertEqual(manifest["scrapeSeconds"], 15)
        self.assertEqual(manifest["eligibility"]["cpu"], {"modeEquals": "idle", "coreIncludeRe2": "^[0-9]+,[0-9]+$"})
        self.assertEqual(manifest["eligibility"]["disk"], {"volumeIncludeRe2": "^[A-Za-z]:$"})
        self.assertEqual(manifest["eligibility"]["network"], {"nicIncludeRe2": ".+", "nicExcludeRe2": "^Software Loopback Interface( [0-9]+)?$"})
        evidence = manifest["evidence"]
        self.assertEqual([evidence[k] for k in ["observations", "observedSeriesPerSnapshot", "projectedRetainedSeriesPerSnapshot",
                         "projectedRemovedSeriesPerSnapshot", "projectedNativeConstituents", "projectedDiagnosticSeries"]], [22, 190, 34, 156, 9, 25])
        self.assertFalse(evidence["measuredAfter"])
        self.assertFalse(evidence["fixedCardinalityContract"])
        self.assertEqual(manifest["sourceProposal"]["sha256"], PROPOSAL_SHA)
        source = ROOT / manifest["sourceProposal"]["path"]
        if source.is_file():  # Private measured evidence need not ship with the public test suite.
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), PROPOSAL_SHA)
            proposal = json.loads(source.read_text())
            self.assertEqual(proposal["source"]["nativeSha256"], evidence["nativeSha256"])
            self.assertEqual(proposal["source"]["backendSha256"], evidence["backendSha256"])
            self.assertEqual(len(proposal["observedProjection"]), 22)
            for row in proposal["observedProjection"]:
                self.assertEqual([row[k] for k in ["observed", "kept", "removed", "metricConstituents", "diagnostics"]], [190, 34, 156, 9, 25])

    def test_original_windows_and_linux_remain_byte_identical_separate(self):
        self.assertEqual(hashlib.sha256(ORIGINAL.read_bytes()).hexdigest(), ORIGINAL_SHA)
        self.assertEqual(hashlib.sha256(LINUX.read_bytes()).hexdigest(), LINUX_SHA)
        original = parse_alloy(ORIGINAL.read_text())
        self.assertFalse(any(c["kind"] == "prometheus.relabel" for c in original))
        self.assertEqual(component(original, "prometheus.scrape", "host")["attrs"]["forward_to"], ["prometheus.remote_write.ingestion.receiver"])
        self.assertNotIn("windows_baseline_v1", LINUX.read_text())
        self.assertNotIn("node_", self.source)

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "real installer recognition requires Windows PowerShell")
    def test_real_installer_recognizes_actual_target_and_refuses_rule_drift(self):
        def quote(value):
            return "'" + str(value).replace("'", "''") + "'"
        with tempfile.TemporaryDirectory(prefix="opsgrid-baseline-v1-fixture-") as root:
            # All mutable paths are fixture-owned. Only function declarations load;
            # entrypoint/service/security/token functions are never invoked.
            script = r'''
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(INSTALLER,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw 'installer AST parse failed' }
foreach($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { . ([scriptblock]::Create($fn.Extent.Text)) }
$script:AlloyConfigDirectory=ROOT
$script:AlloyConfigFile=Join-Path ROOT 'config.alloy'
$script:AgentCredentialFile=Join-Path ROOT 'fixture-credential.jwt'
$script:AlloyCredentialConfigPath=$script:AgentCredentialFile.Replace('\','/')
function Get-AlloyKnownConfigPaths { @($script:AlloyConfigFile) }
[IO.File]::WriteAllText($script:AgentCredentialFile,'fixture-not-a-real-token')
$beforeCredential=[IO.File]::ReadAllBytes($script:AgentCredentialFile)
$gateway='https://gateway.fixture.invalid/custom/api/v1/write'
$original=[IO.File]::ReadAllText(ORIGINAL)
$target=[IO.File]::ReadAllText(PROFILE)
foreach($case in @(@{Kind='Original';Text=$original},@{Kind='Target';Text=$target})) {
  $expanded=Expand-OpsGridProfileTemplate $case.Text $script:AlloyCredentialConfigPath $gateway
  [IO.File]::WriteAllText($script:AlloyConfigFile,$expanded)
  $before=[IO.File]::ReadAllBytes($script:AlloyConfigFile)
  $managed=Get-OpsGridManagedWindowsConfig $script:AlloyConfigFile $script:AgentCredentialFile ORIGINAL PROFILE
  if($managed.Kind -cne $case.Kind -or $managed.GatewayUrl -cne $gateway -or $managed.CredentialPath -cne $script:AlloyCredentialConfigPath) { throw 'real template identity/parameter contract failed' }
  if([Convert]::ToBase64String($before) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:AlloyConfigFile))) { throw 'recognition mutated fixture config' }
  if($case.Kind -ceq 'Target' -and (ConvertTo-OpsGridCanonicalConfig ([Text.Encoding]::UTF8.GetString($managed.TargetConfigBytes))) -cne $managed.Canonical) { throw 'actual target canonical no-op identity failed' }
}
$expanded=Expand-OpsGridProfileTemplate $target $script:AlloyCredentialConfigPath $gateway
$drift=$expanded.Replace('scrape_interval = "15s"','scrape_interval = "30s"')
if($drift -ceq $expanded) { throw 'drift fixture did not change target' }
[IO.File]::WriteAllText($script:AlloyConfigFile,$drift)
$rejected=$false
try { $null=Get-OpsGridManagedWindowsConfig $script:AlloyConfigFile $script:AgentCredentialFile ORIGINAL PROFILE } catch { $rejected=$true }
if(-not $rejected) { throw 'actual-target cadence drift accepted' }
$drift=$expanded.Replace('[0-9]+,[0-9]+','[0-9]+')
if($drift -ceq $expanded) { throw 'rule drift fixture did not change target' }
[IO.File]::WriteAllText($script:AlloyConfigFile,$drift)
$rejected=$false
try { $null=Get-OpsGridManagedWindowsConfig $script:AlloyConfigFile $script:AgentCredentialFile ORIGINAL PROFILE } catch { $rejected=$true }
if(-not $rejected) { throw 'actual-target rule drift accepted' }
if([Convert]::ToBase64String($beforeCredential) -cne [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:AgentCredentialFile))) { throw 'recognition changed fixture credential' }
Write-Output 'REAL_TARGET_RECOGNITION_PASS original,target,canonical_noop,cadence_refusal,rule_refusal,credential_unchanged'
'''
            for key, value in [("INSTALLER", INSTALLER), ("ORIGINAL", ORIGINAL), ("PROFILE", PROFILE), ("ROOT", root)]:
                script = script.replace(key, quote(value))
            result = subprocess.run([shutil.which("powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script],
                                    capture_output=True, text=True, timeout=90)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("REAL_TARGET_RECOGNITION_PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
