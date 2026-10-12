import { QueryClient, MutationObserver, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api/api-error";
import { alertsQueryOptions, alertRulesQueryOptions, alertQueryOptions, acknowledgeAlertMutationOptions, commentAlertMutationOptions } from "../src/features/alerts/hooks/use-alerts";
import { queryKeys } from "../src/lib/query/query-keys";
import { alertCountBadge, canManageAlerts, validateAlertComment, alertActorLabel, toAlertListQuery } from "../src/features/alerts/lib/alert-utils";
import { alertFixture, orgA, orgB } from "./support/alert-fixtures";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const query = { page: 1, pageSize: 50, sort: "severity_desc" as const };
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
describe("alert data rules", () => {
  it('isolates Rules cache by organization and evicts it on terminal failure', async () => {
    const client = new QueryClient(); const key = queryKeys.alertRules(orgA); client.setQueryData(key,{items:[{name:'Private cached definition'}]});
    expect(alertRulesQueryOptions(orgB).queryKey).not.toEqual(key);
    vi.stubGlobal('fetch',vi.fn(async () => json({code:'AUTH_FORBIDDEN',message:'Unavailable'},403)));
    await client.fetchQuery({...alertRulesQueryOptions(orgA),staleTime:0,retry:false}).catch(()=>undefined); expect(client.getQueryData(key)).toBeUndefined(); client.clear();
  });
  it('retains Rules rate-limit deadline across explicit refetch', async () => {
    let now=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>now);const client=new QueryClient();const fetch=vi.fn(async()=>new Response(JSON.stringify({code:'RATE_LIMITED',message:'Unavailable'}),{status:429,headers:{'Retry-After':'60'}}));vi.stubGlobal('fetch',fetch);const options={...alertRulesQueryOptions(orgA),staleTime:0,retry:false};
    await client.fetchQuery(options).catch(()=>undefined);await client.fetchQuery(options).catch(()=>undefined);expect(fetch).toHaveBeenCalledTimes(1);now+=60001;await client.fetchQuery(options).catch(()=>undefined);expect(fetch).toHaveBeenCalledTimes(2);client.clear();
  });
  it('blocks automatic and explicit GET during cooldown and allows it after the received-at deadline',async()=>{
    let now=Date.now(); vi.spyOn(Date,'now').mockImplementation(()=>now); const client=new QueryClient(); const fetch=vi.fn(async()=>new Response(JSON.stringify({code:'RATE_LIMITED',message:'Unavailable'}),{status:429,headers:{'Retry-After':'60'}})); vi.stubGlobal('fetch',fetch); const options={...alertsQueryOptions(orgA,query),staleTime:0,retry:false};
    await client.fetchQuery(options).catch(()=>undefined); await client.fetchQuery(options).catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(1);
    now+=60_001; await client.fetchQuery(options).catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(2); client.clear();
  });
  it.each([403,404])('evicts sensitive detail on HTTP%s after a previous success', async status => {
    const client = new QueryClient(); const fixture = alertFixture(); const key = queryKeys.alert(orgA, fixture.id); client.setQueryData(key, fixture);
    const historyKey = queryKeys.alertEvents(orgA,fixture.id,1,50); client.setQueryData(historyKey,{ items:[{message:'Sensitive comment'}],total:1 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ code:'NOT_FOUND',message:'Unavailable' },status)));
    await client.fetchQuery({ ...alertQueryOptions(orgA,fixture.id), staleTime:0, retry:false }).catch(() => undefined);
    expect(client.getQueryData(key)).toBeUndefined(); expect(client.getQueryData(historyKey)).toBeUndefined(); client.clear();
  });
  it.each([401,403,404])('does not resume terminal HTTP%s on observer remount or enable changes', async status => {
    const client = new QueryClient(); const fetch = vi.fn(async () => json({ code:'NOT_FOUND',message:'Unavailable' },status)); vi.stubGlobal('fetch',fetch); const options = alertsQueryOptions(orgA,query);
    await client.fetchQuery({ ...options,retry:false }).catch(() => undefined); const initialCalls=fetch.mock.calls.length;
    const observer = new QueryObserver(client,options); const unsubscribe=observer.subscribe(()=>{}); await new Promise(resolve=>setTimeout(resolve,10)); observer.setOptions({ ...options,enabled:false }); observer.setOptions(options); await new Promise(resolve=>setTimeout(resolve,10));
    expect(fetch.mock.calls).toHaveLength(initialCalls); unsubscribe(); client.clear();
  });
  it.each([[0, null], [1, "1"], [99, "99"], [100, "99+"], [-1, null], [Number.NaN, null]] as const)("formats actionable badge %s", (count, expected) => expect(alertCountBadge(count)).toBe(expected));
  it.each([["ADMIN", true], ["OPERATOR", true], ["VIEWER", false], [undefined, false]] as const)("gates workflow controls for %s", (role, expected) => expect(canManageAlerts(role)).toBe(expected));
  it("validates comments exactly without corrupting Unicode", () => {
    expect(validateAlertComment("  Checked ✅  ")).toEqual({ message: "Checked ✅" });
    expect(validateAlertComment("🚀".repeat(4000))).toEqual({ message: "🚀".repeat(4000) });
    for (const value of [" ", "\u0000", "\uD800", "x".repeat(4001), "🚀".repeat(4001)]) expect(validateAlertComment(value)).toHaveProperty("error");
  });
  it("resolves actors by local userId with System and honest fallback", () => {
    const members = [{ id: "membership-id", userId: "actor-id", organizationId: orgA, displayName: "Ada", email: "ada@example.test", role: "ADMIN" as const }];
    expect(alertActorLabel(null, members)).toBe("System"); expect(alertActorLabel("actor-id", members)).toBe("Ada");
    expect(alertActorLabel("membership-id", members)).toBe("membership-id"); expect(alertActorLabel("removed-user", members)).toBe("removed-user");
    expect(alertActorLabel("actor-id", [{ ...members[0], displayName: null }])).toBe("ada@example.test");
  });
  it("maps History and omits empty search without changing exact page/filter state", () => {
    expect(toAlertListQuery({ tab: "history", q: " ", page: 3, pageSize: 50, sort: "started_at_asc", severity: "CRITICAL", workflowStatus: "ACKNOWLEDGED" })).toEqual({ page: 3, pageSize: 50, signalStatus: "RESOLVED", severity: "CRITICAL", workflowStatus: "ACKNOWLEDGED", sort: "started_at_asc" });
    expect(toAlertListQuery({ tab: "firing", q: " CPU ", page: 1, pageSize: 50, sort: "severity_desc" })).toEqual({ page: 1, pageSize: 50, signalStatus: "FIRING", sort: "severity_desc", q: "CPU" });
  });
});
describe("captured-tenant workflow mutation options", () => {
  it('retains a late POST cooldown beyond the metadata query previous GC timer',async()=>{
    vi.useFakeTimers(); const client=new QueryClient(); client.setQueryData(queryKeys.me,{user:{id:'actor-a'}}); const key=queryKeys.alertWriteCooldown('actor-a',orgA,alertFixture().id);
    const metadata=new QueryObserver(client,{queryKey:key,queryFn:async()=>null,enabled:false,gcTime:300_000}); const stop=metadata.subscribe(()=>undefined);
    let release!: (response:Response)=>void; const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{release=resolve;})).mockResolvedValue(json(alertFixture())); vi.stubGlobal('fetch',fetch);
    const pending=new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate().catch(()=>undefined); await Promise.resolve(); stop();
    release(new Response(JSON.stringify({code:'RATE_LIMITED',message:'Unavailable'}),{status:429,headers:{'Retry-After':'600'}})); await pending;
    await vi.advanceTimersByTimeAsync(300_001); expect(client.getQueryData(key)).toBeInstanceOf(ApiError); await new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate().catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000); await new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate(); expect(fetch).toHaveBeenCalledTimes(2); client.clear();
  });
  it('enforces shared POST deadline across new observers without affecting other tenant or actor',async()=>{
    let now=Date.now(); vi.spyOn(Date,'now').mockImplementation(()=>now); const client=new QueryClient(); client.setQueryData(queryKeys.me,{user:{id:'actor-a'}}); const fetch=vi.fn(async()=>new Response(JSON.stringify({code:'RATE_LIMITED',message:'Unavailable'}),{status:429,headers:{'Retry-After':'600'}})); vi.stubGlobal('fetch',fetch);
    await new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate().catch(()=>undefined);
    await new MutationObserver(client,commentAlertMutationOptions(client,orgA,alertFixture().id)).mutate({message:'Retry'}).catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.getQueryCache().find({queryKey:queryKeys.alertWriteCooldown('actor-a',orgA,alertFixture().id),exact:true})?.gcTime).toBeGreaterThan(600_000);
    now+=300_001; await new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate().catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(1);
    await new MutationObserver(client,commentAlertMutationOptions(client,orgB,alertFixture().id)).mutate({message:'Other tenant'}).catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(2);
    client.setQueryData(queryKeys.me,{user:{id:'actor-b'}}); await new MutationObserver(client,commentAlertMutationOptions(client,orgA,alertFixture().id)).mutate({message:'Other actor'}).catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(3);
    client.setQueryData(queryKeys.me,{user:{id:'actor-a'}}); now+=300_001; await new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate().catch(()=>undefined); expect(fetch).toHaveBeenCalledTimes(4); client.clear();
  });
  it('updates only originating tenant detail and invalidates its counts without changing signal', async () => {
    const client = new QueryClient(); client.setQueryData(queryKeys.me, { user: { id: 'actor-a' } }); const before = alertFixture(); const other = alertFixture({ organizationId: orgB });
    client.setQueryData(queryKeys.alertList(orgA, query), { total: 1 }); client.setQueryData(queryKeys.alertList(orgB, query), { total: 9 }); client.setQueryData(queryKeys.alert(orgB, before.id), other);
    const saved = { ...before, workflowStatus: 'ACKNOWLEDGED' as const, acknowledgedBy: 'actor-a', acknowledgedAt: '2026-10-10T00:02:00.000Z' };
    vi.stubGlobal('fetch', vi.fn(async () => json(saved))); const options = acknowledgeAlertMutationOptions(client, orgA, before.id); expect(options.retry).toBe(false);
    await new MutationObserver(client, options).mutate(); expect(client.getQueryData(queryKeys.alert(orgA, before.id))).toEqual(saved); expect(saved.signalStatus).toBe('FIRING');
    expect(client.getQueryData(queryKeys.alert(orgB, before.id))).toEqual(other); expect(client.getQueryState(queryKeys.alertList(orgB, query))?.isInvalidated).toBe(false); expect(client.getQueryState(queryKeys.alertList(orgA, query))?.isInvalidated).toBe(true);
    expect(commentAlertMutationOptions(client, orgA, before.id).retry).toBe(false); client.clear();
  });
  it('does not restore an old POST deadline after a cleared session signs in as the same actor',async()=>{
    const client=new QueryClient(); client.setQueryData(queryKeys.me,{user:{id:'actor-a'}}); let release!: (response:Response)=>void; vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;})));
    const pending=new MutationObserver(client,acknowledgeAlertMutationOptions(client,orgA,alertFixture().id)).mutate().catch(()=>undefined); await Promise.resolve(); client.clear(); client.setQueryData(queryKeys.me,{user:{id:'actor-a'}});
    release(new Response(JSON.stringify({code:'RATE_LIMITED',message:'Unavailable'}),{status:429,headers:{'Retry-After':'60'}})); await pending; expect(client.getQueryData(queryKeys.alertWriteCooldown('actor-a',orgA,alertFixture().id))).toBeUndefined(); client.clear();
  });
  it('never repopulates a cleared session after a late successful response', async () => {
    const client = new QueryClient(); client.setQueryData(queryKeys.me, { user: { id: 'actor-a' } }); let release!: (response: Response) => void; vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const saved = alertFixture({ workflowStatus: 'ACKNOWLEDGED' }); const mutation = new MutationObserver(client, acknowledgeAlertMutationOptions(client, orgA, saved.id)); const pending = mutation.mutate(); await Promise.resolve();
    client.clear(); client.setQueryData(queryKeys.me, { user: { id: 'actor-b' } }); release(json(saved)); await pending; expect(client.getQueryData(queryKeys.alert(orgA, saved.id))).toBeUndefined(); client.clear();
  });
});
describe("real TanStack tenant cache options with fetch boundary replaced", () => {
  it("keys tenant and every list filter independently", () => {
    expect(alertsQueryOptions(orgA, query).queryKey).toEqual(["alerts", orgA, "list", query]);
    const keys = [alertsQueryOptions(orgA, query).queryKey, alertsQueryOptions(orgB, query).queryKey, alertsQueryOptions(orgA, { ...query, q: "CPU" }).queryKey, alertsQueryOptions(orgA, { ...query, page: 2 }).queryKey];
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(4);
    expect(alertsQueryOptions(orgA, query)).not.toHaveProperty("placeholderData");
  });
  it("disables no-org, malformed IDs, hidden tabs and closed preview queries", () => {
    const client = new QueryClient(); const enabled = (org: string | null, active = true) => { const options = alertsQueryOptions(org,query,active); const cached = client.getQueryCache().build(client,options); return typeof options.enabled === 'function' ? options.enabled(cached) : options.enabled; };
    expect(enabled(orgA)).toBe(true); for (const org of [null,'','not-an-id']) expect(enabled(org)).toBe(false); expect(enabled(orgA,false)).toBe(false);
    vi.stubGlobal('document',{visibilityState:'hidden'}); expect(enabled(orgA)).toBe(false); client.clear();
  });
  it("cancels an old tenant request and never publishes it to a new tenant cache", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementationOnce((_url: string, init: RequestInit) => { firstSignal = init.signal as AbortSignal; return new Promise<Response>(() => {}); }).mockResolvedValueOnce(json({ items: [alertFixture({ organizationId: orgB })], total: 1, page: 1, pageSize: 50 })); vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const old = client.fetchQuery(alertsQueryOptions(orgA, query)); const cancelled = old.catch(() => undefined);
    await client.cancelQueries({ queryKey: ["alerts", orgA] }); await cancelled;
    expect(firstSignal?.aborted).toBe(true);
    const result = await client.fetchQuery(alertsQueryOptions(orgB, query)); expect(result.items[0].organizationId).toBe(orgB);
    expect(client.getQueryData(["alerts", orgA, "list", query])).toBeUndefined(); client.clear();
  });
  it.each([401, 403, 404, 429, 503])("has bounded retry/poll policy for HTTP %s", async (status) => {
    const error = new ApiError(status, "UNAVAILABLE", "Unavailable"); const options = alertsQueryOptions(orgA, query);
    if (typeof options.retry !== "function") throw new Error("Expected explicit alert retry policy");
    expect(options.retry(0, error)).toBe(status === 503); expect(options.retry(2, error)).toBe(false);
    const client = new QueryClient(); await client.fetchQuery({ ...options, retry: false, queryFn: async () => { throw error; } }).catch(() => undefined);
    const cached = client.getQueryCache().find({ queryKey: options.queryKey });
    if (!cached || typeof options.refetchInterval !== "function") throw new Error("Expected explicit alert polling policy");
    expect(options.refetchInterval(cached)).toBe([401, 403, 404].includes(status) ? false : 30_000); client.clear();
  });
});
