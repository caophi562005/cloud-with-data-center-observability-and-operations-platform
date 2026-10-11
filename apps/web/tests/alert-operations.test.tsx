// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDetailDrawer } from "../src/features/alerts/components/alert-detail-drawer";
import { alertFixture, alertId, eventFixture, orgA } from "./support/alert-fixtures";
import { click, meFixture, mountAlertUi } from "./support/alert-ui-test-utils";
import type { AlertDetail, AlertEvent } from "../src/features/alerts/alert.types";
import type { Role } from "../src/types/domain";
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => { await mounted?.unmount(); mounted = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)); }); }
const button = (name: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === name) ?? null;
async function typeComment(value: string) { const input = document.querySelector('textarea'); if (!input) throw new Error('Missing comment control'); await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
function boundary(overrides: Partial<AlertDetail> = {}, failure?: number, pending?: Promise<void>) {
  let detail = alertFixture(overrides); const events: AlertEvent[] = [eventFixture()]; const posts: RequestInit[] = [];
  vi.stubGlobal('scrollTo', vi.fn()); vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === 'POST') {
      posts.push(init); if (pending) await pending;
      if (failure) return new Response(JSON.stringify({ code: 'UNAVAILABLE', message: 'Request unavailable' }), { status: failure, headers: failure === 429 ? { 'Retry-After': '60' } : undefined });
      if (path.endsWith('/acknowledge')) { detail = { ...detail, workflowStatus: 'ACKNOWLEDGED', acknowledgedBy: 'actor-id', acknowledgedAt: '2026-10-10T00:02:00.000Z' }; events.push(eventFixture({ id: 'ack-event', sequence: events.length + 1, type: 'ACKNOWLEDGED', actorId: 'actor-id', sourceTimeKey: null })); return new Response(JSON.stringify(detail)); }
      const event = eventFixture({ id: 'comment-event', sequence: events.length + 1, type: 'COMMENT_ADDED', actorId: 'actor-id', sourceTimeKey: null, message: JSON.parse(String(init.body)).message as string }); events.push(event); return new Response(JSON.stringify(event));
    }
    if (path.endsWith('/members')) return new Response(JSON.stringify([]));
    if (path.includes('/events')) return new Response(JSON.stringify({ items: events, total: events.length, page: 1, pageSize: 50 }));
    return new Response(JSON.stringify(detail));
  }); vi.stubGlobal('fetch', fetch); return { posts, fetch };
}
async function mount(role: Role = 'ADMIN') { mounted = await mountAlertUi(<AlertDetailDrawer selection={{ organizationId: orgA, alertId }} onClose={vi.fn()} />, '/alerts', meFixture(role)); await settle(); }
function ReopenDrawer() { const [open,setOpen]=useState(true); return <><button type='button' onClick={()=>setOpen(true)}>Reopen drawer</button><AlertDetailDrawer selection={open ? {organizationId:orgA,alertId} : null} onClose={()=>setOpen(false)} /></>; }
describe('authoritative workflow controls using real drawer/hooks and HTTP boundary', () => {
  it.each(['Acknowledge','Add comment'])('preserves %s cooldown across drawer remount until the received-at deadline',async(action)=>{
    let now=Date.now(); vi.spyOn(Date,'now').mockImplementation(()=>now); const api=boundary({},429); mounted=await mountAlertUi(<ReopenDrawer />); await settle(); if(action==='Add comment') await typeComment('Rate limited'); await click(button(action)); await settle(); expect(api.posts).toHaveLength(1);
    await click(document.querySelector('[aria-label="Close alert detail"]')); await click(button('Reopen drawer')); await settle(); expect(button('Acknowledge')?.disabled).toBe(true); expect(button('Add comment')?.disabled).toBe(true); await click(button(action)); expect(api.posts).toHaveLength(1);
    now+=60_001; await click(document.querySelector('[aria-label="Close alert detail"]')); await click(button('Reopen drawer')); await settle(); expect(button('Acknowledge')?.disabled).toBe(false); if(action==='Add comment') await typeComment('After deadline'); await click(button(action)); await settle(); expect(api.posts).toHaveLength(2);
  });
  it.each(['Acknowledge', 'Add comment'])('keeps %s disabled after a 429 response until cooldown ends', async (action) => {
    const api = boundary({}, 429); await mount(); if (action === 'Add comment') await typeComment('Keep rate-limited draft');
    await click(button(action)); await settle(); expect(api.posts).toHaveLength(1); expect(button(action)?.disabled).toBe(true);
    await click(button(action)); await settle(); expect(api.posts).toHaveLength(1);
  });
  it.each(['ADMIN', 'OPERATOR'] as const)('allows %s to acknowledge RESOLVED+OPEN without changing signal', async (role) => {
    const api = boundary({ signalStatus: 'RESOLVED' }); await mount(role); await click(button('Acknowledge')); await settle();
    expect(api.posts).toHaveLength(1); expect(api.posts[0].body).toBe('{}'); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Acknowledged'); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Resolved'); expect(button('Acknowledge')).toBeNull();
  });
  it('keeps Viewer read-only and never submits a workflow POST', async () => {
    const api = boundary(); await mount('VIEWER'); expect(document.querySelector('textarea')).toBeNull(); expect(button('Acknowledge')).toBeNull(); expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/read.only/i); expect(api.posts).toHaveLength(0);
  });
  it.each([['FIRING','OPEN'],['FIRING','ACKNOWLEDGED'],['RESOLVED','OPEN'],['RESOLVED','ACKNOWLEDGED']] as const)('persists comments for %s/%s only after confirmed POST', async (signalStatus, workflowStatus) => {
    const api = boundary({ signalStatus, workflowStatus }); await mount(); await typeComment('  Checked ✅  '); await click(button('Add comment')); await settle();
    expect(api.posts).toHaveLength(1); expect(JSON.parse(String(api.posts[0].body))).toEqual({ message: 'Checked ✅' }); expect(document.querySelector('textarea')?.value).toBe(''); expect(document.querySelector('[aria-label="Alert activity"]')?.textContent).toContain('Checked ✅');
  });
  it('suppresses duplicate clicks and optimistic acknowledgement before server confirmation', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const api = boundary({}, undefined, gate); await mount(); const acknowledge = button('Acknowledge'); await click(acknowledge); await click(acknowledge); await settle(); expect(acknowledge?.disabled).toBe(true); expect(api.posts).toHaveLength(1); expect(document.querySelector('[aria-label="Alert state"]')?.textContent).not.toContain('Acknowledged'); await act(async () => release()); await settle(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Acknowledged');
  });
  it('retains draft on uncertain failure and never automatically retries', async () => {
    const api = boundary({}, 503); await mount(); await typeComment('Keep this draft'); await click(button('Add comment')); await settle(); expect(api.posts).toHaveLength(1); expect(document.querySelector('textarea')?.value).toBe('Keep this draft'); expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/may have been saved/i); expect(button('Add comment')?.disabled).toBe(true);
  });
  it('handles revoked write permission without a saved comment or repeated POST', async () => {
    const api = boundary({}, 403); await mount(); await typeComment('Not persisted'); await click(button('Add comment')); await settle(); expect(api.posts).toHaveLength(1); expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/permission/i); expect(document.querySelector('[aria-label="Alert activity"]')?.textContent).not.toContain('Not persisted');
  });
});
