import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { VmMetricBinding } from './vm-metrics.promql.js';
const bindings: VmMetricBinding[] = [{ vmId: 'v.*', agentId: 'a+', platform: 'windows' }];
async function native() {
  expect(existsSync(new URL('./vm-metrics.windows.promql.ts', import.meta.url))).toBe(true);
  return (await import('./vm-metrics.windows.promql.js')).buildWindowsVmExpressions('o"\\\n', bindings, 300);
}
describe('locked native Windows expressions', () => {
  it('exists as a separate native builder with escaped persisted scope and no Linux/load substitution', async () => {
    const q = await native();
    expect(Object.keys(q.values)).toEqual(['cpu', 'memory', 'disk', 'networkRx', 'networkTx', 'uptimeHours']);
    expect(q.values.cpu).toContain('organization_id="o\\"\\\\\\n"');
    expect(q.values.cpu).toContain('vm_id=~"v\\\\.\\\\*"');
    expect(q.values.cpu).toContain('agent_id=~"a\\\\+"');
    expect(JSON.stringify(q)).not.toMatch(/node_|device!=|fstype|physical_free|system_system_up_time|load1/);
  });
  it('filters observed cores, idle counters and native non-loopback NIC rates without speculative filters', async () => {
    const q = await native();
    expect(q.values.cpu).toContain('core=~"^[0-9]+,[0-9]+$",mode="idle"');
    expect(q.values.cpu).toContain('[5m]');
    expect(q.values.cpu).toContain('clamp_max(clamp_min(');
    for (const name of ['networkRx', 'networkTx'] as const) {
      expect(q.values[name]).toContain('nic!="",nic!~"^Software Loopback Interface( [0-9]+)?$"');
      expect(q.values[name]).toContain('* 8 / 1000000');
      expect(q.values[name]).not.toMatch(/Ethernet|Hyper|veth|lo"/);
    }
  });
  it('requires finite valid matched raw composites and fresh constituents at each evaluation', async () => {
    const q = await native();
    expect(q.values.memory).toContain('windows_memory_available_bytes');
    expect(q.values.memory).toContain('windows_memory_physical_total_bytes');
    expect(q.values.disk).toContain('volume=~"^[A-Za-z]:$"');
    for (const name of ['memory', 'disk'] as const) {
      expect(q.values[name]).toContain('> 0');
      expect(q.values[name]).toContain('>= 0');
      expect(q.values[name]).toContain('< +Inf');
      expect(q.values[name]).toContain('<=');
      expect(q.values[name]).toContain('time() - timestamp(windows_');
      expect(q.values[name]).toContain('<= 300');
      expect(q.values[name]).not.toContain('on (organization_id,vm_id,agent_id)');
    }
  });
  it('uses raw Unix boot and raw source timestamps including marked constituents before union', async () => {
    const q = await native();
    expect(q.values.uptimeHours).toContain('windows_system_boot_time_timestamp');
    expect(q.values.uptimeHours).toContain('<= time()');
    expect(q.values.uptimeHours).toContain('/ 3600');
    expect(q.source).toContain('"__ops_source", "available"');
    expect(q.source).toContain('"__ops_source", "total"');
    expect(q.source).toContain('"__ops_source", "free"');
    expect(q.source).toContain('"__ops_source", "size"');
    expect(q.lastSeen).toContain('[7d:60s]');
    expect(q.lastSeen).not.toMatch(/timestamp\(\(?rate|timestamp\(\(?max|load/);
    for (const family of ['cpu_time_total', 'memory_available_bytes', 'memory_physical_total_bytes', 'logical_disk_free_bytes', 'logical_disk_size_bytes', 'net_bytes_received_total', 'net_bytes_sent_total', 'system_boot_time_timestamp']) {
      expect(q.lastSeen).toContain(`timestamp(windows_${family}{`);
    }
  });
});
