import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildWindowsVmExpressions } from './vm-metrics.windows.promql.js';
const root = new URL('../../../../../', import.meta.url);
const fixtureUrl = new URL('./fixtures/windows-native-metrics.json', import.meta.url);
const yamlUrl = new URL('../../../test/fixtures/windows-promql-v1.test.yml', import.meta.url);
const manifestUrl = new URL('docs/superpowers/plans/2026-10-05-windows-metric-manifest-v1.json', root);
const manifestHash = '5317066ec40a0044b3000bcd3068645cd3a827e70f5589fc839f0d34d587eaf3';
describe('native capture provenance and exact promtool expression binding', () => {
  it('retains actual captured native values/types/labels without treating vector evaluation as raw time', () => {
    expect(existsSync(fixtureUrl)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    expect(createHash('sha256').update(readFileSync(manifestUrl)).digest('hex')).toBe(manifestHash);
    expect(fixture.manifestSha256).toBe(manifestHash);
    expect(fixture.vectorTimestampIsRawScrapeTimestamp).toBe(false);
    const families = Object.values(manifest.metrics).flatMap((m: unknown) => (m as { rawSources: { family: string; type: string; unit: string }[] }).rawSources);
    expect(fixture.families).toEqual(families.map(({ family, type, unit }) => ({ family, type, unit })));
    expect(fixture.samples).toHaveLength(21);
    expect(fixture.samples.find((s: { metric: { __name__: string } }) => s.metric.__name__ === 'windows_memory_available_bytes').value[1]).toBe('100569088');
    const backendUrl = new URL(fixture.sourceCapture, root);
    expect(createHash('sha256').update(readFileSync(backendUrl)).digest('hex')).toBe(fixture.sourceCaptureSha256);
    const captured = JSON.parse(readFileSync(backendUrl, 'utf8'));
    expect(fixture.samples).toEqual(captured.samples.filter((s: { metric: { __name__: string } }) => families.some((f) => f.family === s.metric.__name__)));
  });
  it('every JSON one-line marked YAML expression is exactly production output, not a handwritten formula', () => {
    expect(existsSync(yamlUrl)).toBe(true);
    const yaml = readFileSync(yamlUrl, 'utf8');
    const bindings = [{ vmId: 'fixture-vm', agentId: 'fixture-agent', platform: 'windows' as const }];
    const matches = [...yaml.matchAll(/^\s+- expr: (".*") # builder:([a-zA-Z]+)@(\d+)$/gm)];
    expect(matches.length).toBeGreaterThanOrEqual(30);
    expect((yaml.match(/^\s+- expr:/gm) ?? []).length).toBe(matches.length);
    for (const [, scalar, name, stale] of matches) {
      const q = buildWindowsVmExpressions('fixture-org', bindings, Number(stale));
      const expected = name === 'current' || name === 'source' || name === 'lastSeen' ? q[name] : q.values[name as keyof typeof q.values];
      expect(JSON.parse(scalar!)).toBe(expected);
    }
    for (const scenario of ['counter-reset', 'aggregate-core', 'matched-volume', 'zero-values', 'zero-denominator', 'missing-constituents', 'stale-composite', 'boot-evaluation', 'same-target', 'raw-history', 'invalid-nonfinite', 'partial-cpu-critical']) expect(yaml).toContain(scenario);
  });
});
