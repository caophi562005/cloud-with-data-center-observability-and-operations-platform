import { describe, expect, it } from 'vitest';
import { buildVmExpressions } from './vm-metrics.promql.js';
describe('trusted VM PromQL', () => {
  it('derives latest heartbeat and seven-day history from every eligible raw host family, never only memory total', () => {
    const q = buildVmExpressions('o', [{ vmId: 'v', agentId: 'a', platform: 'linux' }]);
    const heartbeat = q.source.split(
      ' or label_replace((max by (organization_id,vm_id,agent_id)',
    )[1];
    expect(heartbeat).toBeDefined();
    for (const metric of [
      'node_cpu_seconds_total',
      'node_memory_MemAvailable_bytes',
      'node_memory_MemTotal_bytes',
      'node_filesystem_avail_bytes',
      'node_filesystem_size_bytes',
      'node_network_receive_bytes_total',
      'node_network_transmit_bytes_total',
      'node_load1',
      'node_boot_time_seconds',
    ]) {
      expect(heartbeat).toContain(`timestamp(${metric}{`);
      expect(q.lastSeen).toContain(`timestamp(${metric}{`);
    }
    expect(q.lastSeen).toContain('mode="idle"');
    expect(q.lastSeen).toContain('device!="lo"');
    expect(q.lastSeen).toContain('fstype!~');
    expect(q.lastSeen).not.toContain('timestamp(rate(');
  });
  it('escapes exact organization and regex VM/agent labels with fixed aggregation keys and units', () => {
    const q = buildVmExpressions('o"\\\n', [{ vmId: 'v.*', agentId: 'a+', platform: 'linux' }]);
    expect(q.cpu).toContain('organization_id="o\\"\\\\\\n"');
    expect(q.cpu).toContain('vm_id=~"v\\\\.\\\\*"');
    expect(q.cpu).toContain('agent_id=~"a\\\\+"');
    expect(q.cpu).toContain('rate(node_cpu_seconds_total');
    expect(q.memory).toContain('node_memory_MemAvailable_bytes');
    expect(q.disk).toContain('max by (organization_id,vm_id,agent_id)');
    expect(q.networkRx).toContain('* 8 / 1000000');
    expect(q.networkTx).toContain('device!="lo"');
    expect(q.uptimeHours).toContain('/ 3600');
    expect(q.source).toContain('timestamp(node_cpu_seconds_total');
    expect(q.source).toContain('"__ops_source", "available"');
    expect(q.source).toContain('"__ops_source", "total"');
    expect(q.source).toContain('"__ops_source", "size"');
    expect(q.lastSeen).toContain('[7d:60s]');
    expect(q.current).not.toContain('org_id=');
  });
});
