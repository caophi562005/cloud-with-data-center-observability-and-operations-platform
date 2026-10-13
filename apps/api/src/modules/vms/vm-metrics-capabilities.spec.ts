import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  getVmMetricsCapabilities,
  resolveVmMetricPlatform,
} from './vm-metrics-capabilities.js';
import type {
  MetricName,
  VmMetricExpressions,
  VmMetricPlatform,
  VmMetricsCapabilities,
} from './vms.types.js';

const linuxDistros = [
  ['Ubuntu', 'Ubuntu 24.04', 'Ubuntux 24.04'],
  [
    'Debian GNU/Linux',
    'Debian GNU/Linux 12 (bookworm)',
    'Debian GNU/Linuxish 12',
  ],
  ['Debian', 'Debian 12', 'Debianish 12'],
  ['CentOS Linux', 'CentOS Linux 7 (Core)', 'CentOS Linuxish 7'],
  ['CentOS Stream', 'CentOS Stream 9', 'CentOS Streamish 9'],
  [
    'Red Hat Enterprise Linux',
    'Red Hat Enterprise Linux 9.4 (Plow)',
    'Red Hat Enterprise Linuxish 9.4',
  ],
  ['Rocky Linux', 'Rocky Linux 9.4 (Blue Onyx)', 'Rocky Linuxish 9.4'],
  ['AlmaLinux', 'AlmaLinux 9.4 (Seafoam Ocelot)', 'AlmaLinuxish 9.4'],
  [
    'Fedora Linux',
    'Fedora Linux 40 (Workstation Edition)',
    'Fedora Linuxish 40',
  ],
  ['Amazon Linux', 'Amazon Linux 2023', 'Amazon Linuxish 2023'],
  [
    'SUSE Linux Enterprise Server',
    'SUSE Linux Enterprise Server 15 SP6',
    'SUSE Linux Enterprise Serverish 15',
  ],
  ['openSUSE Leap', 'openSUSE Leap 15.6', 'openSUSE Leapish 15.6'],
  [
    'openSUSE Tumbleweed',
    'openSUSE Tumbleweed 20261001',
    'openSUSE Tumbleweedish 20261001',
  ],
  ['Arch Linux', 'Arch Linux 2026.10.01', 'Arch Linuxish 2026.10.01'],
] as const;

const linuxMetrics: MetricName[] = [
  'cpu',
  'memory',
  'disk',
  'networkRx',
  'networkTx',
  'load',
  'uptimeHours',
];
const windowsMetrics: MetricName[] = [
  'cpu',
  'memory',
  'disk',
  'networkRx',
  'networkTx',
  'uptimeHours',
];

describe('VM metric capabilities', () => {
  it.each([
    ['Linux', 'linux', linuxMetrics],
    ['Windows', 'windows', windowsMetrics],
    [null, 'unknown', []],
    ['unknown', 'unknown', []],
    ['not-windows', 'unknown', []],
    ['windowsish', 'unknown', []],
  ] as const)(
    'known_os_capabilities_are_stable for %s',
    (os, platform, supported) => {
      expect(getVmMetricsCapabilities(resolveVmMetricPlatform(os))).toEqual({
        platform,
        supported,
      });
    },
  );

  it.each(['linux', 'windows'] as const)(
    'reports full %s support without any scrape input',
    (platform) => {
      expect(getVmMetricsCapabilities(platform).supported).toEqual(
        platform === 'linux' ? linuxMetrics : windowsMetrics,
      );
    },
  );

  it('does not advertise Windows load support', () => {
    expect(getVmMetricsCapabilities('windows').supported).not.toContain('load');
  });

  it('isolates returned capability arrays and platform objects between calls', () => {
    for (const platform of ['linux', 'windows', 'unknown'] as const) {
      const first = getVmMetricsCapabilities(platform);
      first.supported.splice(0, first.supported.length, 'load');
      first.platform = 'unknown';
      expect(getVmMetricsCapabilities(platform)).toEqual({
        platform,
        supported:
          platform === 'linux'
            ? linuxMetrics
            : platform === 'windows'
              ? windowsMetrics
              : [],
      });
    }
  });

  it('exports the exact additive metric contract types', () => {
    expectTypeOf<MetricName>().toEqualTypeOf<
      | 'cpu'
      | 'memory'
      | 'disk'
      | 'networkRx'
      | 'networkTx'
      | 'load'
      | 'uptimeHours'
    >();
    expectTypeOf<VmMetricPlatform>().toEqualTypeOf<
      'linux' | 'windows' | 'unknown'
    >();
    expectTypeOf<VmMetricsCapabilities>().toEqualTypeOf<{
      platform: VmMetricPlatform;
      supported: MetricName[];
    }>();
    expectTypeOf<VmMetricExpressions>().toEqualTypeOf<{
      values: Partial<Record<MetricName, string>>;
      current: string;
      source: string;
      lastSeen: string;
    }>();
    expectTypeOf(resolveVmMetricPlatform).toEqualTypeOf<
      (os: string | null) => VmMetricPlatform
    >();
    expectTypeOf(getVmMetricsCapabilities).toEqualTypeOf<
      (platform: VmMetricPlatform) => VmMetricsCapabilities
    >();
  });
});

describe('persisted enrollment OS platform resolution', () => {
  it.each(['Linux', '  lInUx \t', 'Ubuntu 24.04', '  uBuNtU\t24.04 LTS  '])(
    'recognizes Linux fixture %s',
    (os) => expect(resolveVmMetricPlatform(os)).toBe('linux'),
  );

  it.each(linuxDistros)('recognizes exact distro %s', (name) => {
    expect(resolveVmMetricPlatform(name)).toBe('linux');
    expect(resolveVmMetricPlatform(`  ${name.toUpperCase()}  `)).toBe('linux');
  });

  it.each(linuxDistros)(
    'recognizes versioned distro %s',
    (_name, versioned) => {
      expect(resolveVmMetricPlatform(versioned)).toBe('linux');
    },
  );

  it.each(linuxDistros)(
    'rejects near-name distro spoof %s',
    (_name, _versioned, spoof) => {
      expect(resolveVmMetricPlatform(spoof)).toBe('unknown');
    },
  );

  it.each(linuxDistros)('requires a version digit after distro %s', (name) => {
    expect(resolveVmMetricPlatform(`${name} rolling`)).toBe('unknown');
    expect(resolveVmMetricPlatform(`${name}24.04`)).toBe('unknown');
    expect(resolveVmMetricPlatform(`not-${name} 24.04`)).toBe('unknown');
  });

  it.each([
    'Windows',
    '  wInDoWs  ',
    'Windows 11',
    'Windows 10.0.26100',
    'Windows 11 Pro',
    'Windows Server 2025 Datacenter',
    'Windows Server 2025 Datacenter 10.0.26100',
    'Microsoft Windows',
    'Microsoft Windows 11 Pro 10.0.26100',
    'Microsoft Windows Server 2025 Datacenter 10.0.26100',
    '  mIcRoSoFt wInDoWs sErVeR 2025 Datacenter 10.0.26100  ',
  ])('recognizes bounded Windows fixture %s', (os) => {
    expect(resolveVmMetricPlatform(os)).toBe('windows');
  });

  it.each([
    null,
    '',
    ' \t ',
    'unknown',
    'not-windows',
    'windowsish',
    'WindowsServer2025Datacenter',
    'Ubuntu24.04',
    'Linuxish',
    'Linux 6.8',
    'My Linux',
    'GNU/Linux',
    'CentOS 9',
    'Fedora 40',
    'Windowsish 11',
    'Windows 11Pro',
    'Windows Server 2025Datacenter',
    'Windows Server',
    'Windows Pro',
    'Windows Server v2025',
    'Windows 10.0.26100spoof',
    'Windows 10.',
    'Windows 10..0',
    'MicrosoftWindows 11',
    'not-Microsoft Windows 11',
    'Fake Microsoft Windows 11',
    'Microsoft Windowsish 11',
    'Microsoft Microsoft Windows 11',
    'Microsoft Linux',
  ])('rejects unknown or unbounded OS fixture %s', (os) => {
    expect(resolveVmMetricPlatform(os)).toBe('unknown');
    expect(
      getVmMetricsCapabilities(resolveVmMetricPlatform(os)).supported,
    ).toEqual([]);
  });

  it('does not rewrite the persisted installer-shaped OS', () => {
    const enrollment = {
      os: '  Microsoft Windows Server 2025 Datacenter 10.0.26100  ',
    };
    expect(resolveVmMetricPlatform(enrollment.os)).toBe('windows');
    expect(enrollment.os).toBe(
      '  Microsoft Windows Server 2025 Datacenter 10.0.26100  ',
    );
  });
});
