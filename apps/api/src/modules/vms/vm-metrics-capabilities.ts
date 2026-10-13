import type {
  MetricName,
  VmMetricPlatform,
  VmMetricsCapabilities,
} from './vms.types.js';

const SUPPORTED_METRICS: Record<VmMetricPlatform, readonly MetricName[]> = {
  linux: [
    'cpu',
    'memory',
    'disk',
    'networkRx',
    'networkTx',
    'load',
    'uptimeHours',
  ],
  windows: ['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'uptimeHours'],
  unknown: [],
};

// Only reviewed enrollment OS names; a distro suffix must start with a version digit.
const LINUX_DISTRO =
  /^(?:Ubuntu|Debian GNU\/Linux|Debian|CentOS Linux|CentOS Stream|Red Hat Enterprise Linux|Rocky Linux|AlmaLinux|Fedora Linux|Amazon Linux|SUSE Linux Enterprise Server|openSUSE Leap|openSUSE Tumbleweed|Arch Linux)(?:\s+[0-9]|$)/i;

export function resolveVmMetricPlatform(os: string | null): VmMetricPlatform {
  if (os === null) return 'unknown';
  const normalized = os.trim();
  if (/^Linux$/i.test(normalized) || LINUX_DISTRO.test(normalized)) {
    return 'linux';
  }

  const windowsOs = normalized.replace(/^Microsoft /i, '');
  if (
    /^Windows$/i.test(windowsOs) ||
    /^Windows (?:Server )?[0-9]+(?:\.[0-9]+)*(?:\s|$)/i.test(windowsOs)
  ) {
    return 'windows';
  }
  return 'unknown';
}

export function getVmMetricsCapabilities(
  platform: VmMetricPlatform,
): VmMetricsCapabilities {
  return { platform, supported: [...SUPPORTED_METRICS[platform]] };
}
