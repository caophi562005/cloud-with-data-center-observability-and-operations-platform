import { apiFetch } from "../../../lib/api/http-client";
import type { Vm, VmAgentSummary, VmCurrentMetrics, VmMetricsRange, VmTelemetryMetadata, VmTimeRange } from "../vm.types";

const JSON_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export interface VmApiTag {
  id: string;
  key: string;
  value: string;
}

export type VmApiAgent = VmAgentSummary;

export interface VmApiRecord extends Partial<VmTelemetryMetadata> {
  id: string;
  organizationId: string;
  hostname: string;
  ipAddress: string | null;
  os: string | null;
  status: Vm["status"];
  createdAt: string;
  updatedAt: string;
  tags: VmApiTag[];
  agent: VmApiAgent | null;
  metrics?: Vm["metrics"];
  lastSeenAt?: string | null;
  metricsState?: Vm["metricsState"];
  metricsCapabilities?: Vm["metricsCapabilities"];
}

export interface VmCreateApiInput {
  hostname: string;
  ipAddress?: string;
}

export interface VmApiPage {
  items: VmApiRecord[];
  page: number;
  pageSize: number;
  total: number;
}

export interface VmEnrollmentToken {
  tokenId: string;
  token: string;
  expiresAt: string;
}

export interface VmCreateApiResponse {
  vm: VmApiRecord;
  enrollment: VmEnrollmentToken;
}

function vmsPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/vms`;
}

function vmPath(organizationId: string, vmId: string): string {
  return `${vmsPath(organizationId)}/${encodeURIComponent(vmId)}`;
}

function toVm(response: VmApiRecord): Vm {
  const tags = Object.fromEntries(
    response.tags.map((tag) => [tag.key, tag.value]),
  );
  const normalizedOs = response.os?.trim().toLowerCase() ?? "";
  const isWindows = normalizedOs.includes("windows");
  const isLinux = [
    "linux",
    "ubuntu",
    "debian",
    "rhel",
    "red hat",
    "centos",
    "alpine",
    "fedora",
    "suse",
    "rocky",
    "alma",
  ].some((name) => normalizedOs.includes(name));

  return {
    id: response.id,
    hostname: response.hostname,
    osType: isWindows ? "Windows" : isLinux ? "Linux" : "Unknown",
    osVersion: response.os ?? "Unknown",
    ipAddress: response.ipAddress ?? "—",
    status: response.status,
    tags,
    tagIds: Object.fromEntries(response.tags.map((tag) => [tag.key, tag.id])),
    agentStatus: response.agent?.status ?? null,
    agent: response.agent,
    collectorType: response.collectorType !== undefined ? response.collectorType : response.agent?.collectorType ?? null,
    collectorVersion: response.collectorVersion !== undefined ? response.collectorVersion : response.agent?.collectorVersion ?? null,
    buildId: response.buildId !== undefined ? response.buildId : response.agent?.buildId ?? null,
    telemetryCompatibility: response.telemetryCompatibility ?? "unknown",
    telemetryDelivery: response.telemetryDelivery ?? "unknown",
    hostState: response.hostState ?? "unknown",
    lastControlContactAt: response.lastControlContactAt !== undefined ? response.lastControlContactAt : response.agent?.lastControlContactAt ?? null,
    lastSeenAt: response.lastSeenAt ?? null,
    createdAt: response.createdAt,
    metrics: response.metrics ?? null,
    metricsState: response.metricsState,
    ...(response.metricsCapabilities !== undefined ? { metricsCapabilities: response.metricsCapabilities } : {}),
  };
}

export interface VmCreateResponse {
  vm: Vm;
  enrollment: VmEnrollmentToken;
}

const VM_LIST_PAGE_SIZE = 100;

async function getVmPage(
  organizationId: string,
  page: number,
  signal?: AbortSignal,
): Promise<VmApiPage> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(VM_LIST_PAGE_SIZE),
  });

  return apiFetch<VmApiPage>(`${vmsPath(organizationId)}?${params.toString()}`, {
    method: "GET",
    signal,
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}

export async function getVms(organizationId: string, signal?: AbortSignal): Promise<Vm[]> {
  const firstPage = await getVmPage(organizationId, 1, signal);
  const pageCount = Math.ceil(firstPage.total / firstPage.pageSize);

  if (pageCount <= 1) {
    return firstPage.items.map(toVm);
  }

  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      getVmPage(organizationId, index + 2, signal),
    ),
  );

  return [firstPage, ...remainingPages]
    .flatMap((page) => page.items)
    .map(toVm);
}

export async function getVm(
  organizationId: string,
  vmId: string,
  signal?: AbortSignal,
): Promise<Vm> {
  const response = await apiFetch<VmApiRecord>(vmPath(organizationId, vmId), {
    method: "GET",
    signal,
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  return toVm(response);
}

export async function issueVmEnrollmentToken(
  organizationId: string,
  vmId: string,
  signal?: AbortSignal,
): Promise<VmEnrollmentToken> {
  return apiFetch<VmEnrollmentToken>(`${vmPath(organizationId, vmId)}/enrollment-token`, {
    method: "POST",
    signal,
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}

export interface OrganizationInstallCode {
  id: string;
  token: string;
  expiresAt: string;
  maxUses: 1;
}

function installCodesPath(organizationId: string): string {
  return `/api/v1/organizations/${encodeURIComponent(organizationId)}/agent-install-codes`;
}

// Secret responses go directly to component-local state, never a query/mutation cache.
export function issueOrganizationInstallCode(organizationId: string, signal?: AbortSignal): Promise<OrganizationInstallCode> {
  return apiFetch<OrganizationInstallCode>(installCodesPath(organizationId), {
    method: "POST", signal, cache: "no-store", headers: { Accept: "application/json" },
  });
}

export function revokeOrganizationInstallCode(organizationId: string, id: string, signal?: AbortSignal): Promise<void> {
  return apiFetch<void>(`${installCodesPath(organizationId)}/${encodeURIComponent(id)}`, {
    method: "DELETE", signal, headers: { Accept: "application/json" },
  });
}

export function revokeVmAgent(organizationId: string, vmId: string, signal?: AbortSignal): Promise<void> {
  return apiFetch<void>(`${vmPath(organizationId, vmId)}/agent/revoke`, {
    method: "POST", signal, headers: { Accept: "application/json" },
  });
}

export async function createVm(
  organizationId: string,
  input: VmCreateApiInput,
): Promise<VmCreateResponse> {
  const response = await apiFetch<VmCreateApiResponse>(vmsPath(organizationId), {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });

  return {
    vm: toVm(response.vm),
    enrollment: response.enrollment,
  };
}

export async function getVmCurrentMetrics(organizationId: string, vmId: string, signal?: AbortSignal): Promise<VmCurrentMetrics> {
  return apiFetch<VmCurrentMetrics>(`${vmPath(organizationId, vmId)}/metrics/current`, {
    method: "GET", signal, headers: { Accept: "application/json" },
  });
}

export async function getVmMetricsRange(organizationId: string, vmId: string, range: VmTimeRange, signal?: AbortSignal): Promise<VmMetricsRange> {
  return apiFetch<VmMetricsRange>(`${vmPath(organizationId, vmId)}/metrics/range?${new URLSearchParams({ range })}`, {
    method: "GET", signal, headers: { Accept: "application/json" },
  });
}

export async function updateVmTag(organizationId: string, vmId: string, tagId: string, input: { key: string; value: string }): Promise<VmApiTag> {
  return apiFetch<VmApiTag>(`${vmPath(organizationId, vmId)}/tags/${encodeURIComponent(tagId)}`, {
    method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify(input),
  });
}

export async function deleteVmTag(organizationId: string, vmId: string, tagId: string): Promise<void> {
  return apiFetch<void>(`${vmPath(organizationId, vmId)}/tags/${encodeURIComponent(tagId)}`, {
    method: "DELETE", headers: { Accept: "application/json" },
  });
}

export async function addVmTag(
  organizationId: string,
  vmId: string,
  input: { key: string; value: string },
): Promise<VmApiTag> {
  return apiFetch<VmApiTag>(`${vmPath(organizationId, vmId)}/tags`, {
    method: "POST",
    credentials: "include",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}
