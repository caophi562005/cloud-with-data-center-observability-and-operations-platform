// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router-dom';
import { AlertBell } from '../src/features/alerts/components/alert-bell';
import { AlertDrawerProvider } from '../src/features/alerts/components/alert-drawer-provider';
import { AlertDetailDrawer } from '../src/features/alerts/components/alert-detail-drawer';
import { useAlertDrawer } from '../src/features/alerts/hooks/use-alert-drawer';
import { useTenant } from '../src/app/providers/app-providers';
import { alertFixture, alertId, orgB } from './support/alert-fixtures';
import { click, meFixture, mountAlertUi } from './support/alert-ui-test-utils';
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => { await mounted?.unmount(); mounted = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Alerts:"]');
const panel = () => document.querySelector<HTMLElement>('[aria-label="Unacknowledged firing alerts"]');
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); }); }
function Harness() { const drawer = useAlertDrawer(); const tenant = useTenant(); const location = useLocation(); return <><AlertBell /><button type="button" onClick={() => tenant.selectOrganization(orgB)}>Switch organization</button><output aria-label="URL">{location.pathname}{location.search}</output><AlertDetailDrawer selection={drawer.selection} onClose={drawer.closeAlert} /></>; }
function boundary(total = 1, failure?: number, pending?: Promise<void>) {
  vi.stubGlobal('scrollTo', vi.fn()); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const fetch = vi.fn(async (input: string | URL | Request) => { const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/members')) return new Response('[]');
    if (url.pathname.endsWith('/events')) return new Response(JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }));
    if (url.pathname.endsWith(alertId)) return new Response(JSON.stringify(alertFixture()));
    if (url.searchParams.get('pageSize') === '6' && pending) await pending;
    if (failure) return new Response(JSON.stringify({ code: 'UNAVAILABLE', message: 'Unavailable' }), { status: failure });
    const count = url.pathname.includes(orgB) ? 0 : total;
    const items = url.searchParams.get('pageSize') === '6' && count ? [alertFixture({ severity: 'CRITICAL' })] : [];
    return new Response(JSON.stringify({ items, total: count, page: 1, pageSize: Number(url.searchParams.get('pageSize')) }));
  }); vi.stubGlobal('fetch', fetch); return fetch;
}
async function mount(me = meFixture()) { mounted = await mountAlertUi(<AlertDrawerProvider><Harness /></AlertDrawerProvider>, '/vms', me); await settle(); }
describe('real PxlKit header bell and global drawer handoff', () => {
  it.each([[0,null],[1,'1'],[99,'99'],[100,'99+']] as const)('shows exact accessible %s count and bounded visual badge', async (total, badge) => {
    const fetch = boundary(total); await mount(); expect(trigger()?.getAttribute('aria-label')).toBe(`Alerts: ${total} unacknowledged firing alerts`);
    expect(trigger()?.textContent).toBe(badge ?? ''); expect(fetch.mock.calls.some(([url]) => String(url).includes('pageSize=6'))).toBe(false);
    const url = new URL(String(fetch.mock.calls[0][0]), 'https://example.test'); expect(url.searchParams.get('signalStatus')).toBe('FIRING'); expect(url.searchParams.get('workflowStatus')).toBe('OPEN'); expect(url.searchParams.get('pageSize')).toBe('1');
  });
  it('fetches prioritized six only while open and moves selection to the same drawer without POST', async () => {
    const fetch = boundary(8); await mount(); await click(trigger()); await settle(); expect(panel()).not.toBeNull();
    const preview = fetch.mock.calls.find(([url]) => String(url).includes('pageSize=6')); expect(new URL(String(preview?.[0]), 'https://example.test').searchParams.get('sort')).toBe('severity_desc');
    expect(panel()?.textContent).toContain('edge-example'); expect(panel()?.textContent).toContain('Critical');
    await click(panel()?.querySelector('button[aria-label^="Open alert"]') ?? null); await settle(); expect(panel()).toBeNull(); expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
    expect(fetch.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await settle(); expect(document.activeElement).toBe(trigger());
  });
  it('keeps failed count visibly unavailable instead of reporting zero and offers explicit retry', async () => {
    boundary(1, 403); await mount(); expect(trigger()?.getAttribute('aria-label')).toMatch(/unavailable/i); await click(trigger()); await settle(); expect(panel()?.textContent).toMatch(/unavailable/i); expect(panel()?.querySelector('button')?.textContent).toMatch(/retry/i);
  });
  it('shows loading followed by true empty state and links to Firing/Open intent', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); boundary(0, undefined, gate); await mount(); await click(trigger()); expect(panel()?.textContent).toMatch(/loading/i);
    await act(async () => release()); await settle(); expect(panel()?.textContent).toMatch(/no unacknowledged/i); await click([...panel()!.querySelectorAll('a')].find((a) => a.textContent === 'View all alerts') ?? null); await settle();
    expect(document.querySelector('[aria-label="URL"]')?.textContent).toContain('/alerts'); expect(document.querySelector('[aria-label="URL"]')?.textContent).toContain('workflowStatus=OPEN');
  });
  it('supports named keyboard panel focus, Escape and outside-pointer dismissal', async () => {
    boundary(); await mount(); trigger()?.focus(); await click(trigger()); await settle(); expect(panel()?.contains(document.activeElement)).toBe(true);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await settle(); expect(panel()).toBeNull(); expect(document.activeElement).toBe(trigger());
    await click(trigger()); await settle(); await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); }); await settle(); expect(panel()).toBeNull();
  });
  it('does not fetch alerts without organization or while document hidden', async () => {
    const fetch = boundary(); await mount({ ...meFixture(), organizations: [] }); expect(trigger()?.disabled).toBe(true); expect(fetch).not.toHaveBeenCalled();
    await mounted?.unmount(); mounted = undefined; vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); await mount(); expect(fetch).not.toHaveBeenCalled();
  });
  it('never retains previous-organization preview or count after tenant switch', async () => {
    boundary(100); await mount(); await click(trigger()); await settle(); await click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Switch organization') ?? null); await settle();
    expect(trigger()?.getAttribute('aria-label')).toBe('Alerts: 0 unacknowledged firing alerts'); expect(panel()).toBeNull();
  });
});
