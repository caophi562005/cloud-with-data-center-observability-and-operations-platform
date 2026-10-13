import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getVms,
  issueVmEnrollmentToken,
} from "../src/features/vms/api/vms.api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("VM API inventory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads every paginated API page and maps records to the VM UI shape", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        items: [
          {
            id: "vm-linux",
            organizationId: "org-1",
            hostname: "edge-linux-01",
            ipAddress: "10.0.0.1",
            os: "Ubuntu 24.04",
            status: "HEALTHY",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T01:00:00.000Z",
            tags: [{ id: "tag-1", key: "site", value: "sea-01" }],
            agent: {
              status: "ACTIVE",
              enrolledAt: "2026-10-01T00:00:00.000Z",
              lastSeenAt: "2026-10-01T01:00:00.000Z",
            },
          },
        ],
        page: 1,
        pageSize: 100,
        total: 101,
      }))
      .mockResolvedValueOnce(jsonResponse({
        items: [
          {
            id: "vm-windows",
            organizationId: "org-1",
            hostname: "api-windows-01",
            ipAddress: null,
            os: "Windows Server 2022",
            status: "DISCONNECTED",
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T01:00:00.000Z",
            tags: [],
            agent: null,
          },
        ],
        page: 2,
        pageSize: 100,
        total: 101,
      }));
    vi.stubGlobal("fetch", fetchMock);

    const vms = await getVms("org-1");

    expect(vms).toEqual([
      expect.objectContaining({
        id: "vm-linux",
        hostname: "edge-linux-01",
        osType: "Linux",
        osVersion: "Ubuntu 24.04",
        tags: { site: "sea-01" },
        agentStatus: "ACTIVE",
        // Legacy agent contact must not become native metric freshness.
        lastSeenAt: null,
        hostState: "unknown",
        telemetryCompatibility: "unknown",
        telemetryDelivery: "unknown",
        lastControlContactAt: null,
        metrics: null,
        tagIds: { site: "tag-1" },
      }),
      expect.objectContaining({
        id: "vm-windows",
        osType: "Windows",
        ipAddress: "—",
        tags: {},
        lastSeenAt: null,
      }),
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/organizations/org-1/vms?page=1&pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/organizations/org-1/vms?page=2&pageSize=100",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("requests a fresh enrollment token for a VM", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      tokenId: "token-1",
      token: "ENR_test-token",
      expiresAt: "2026-10-02T00:00:00.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(issueVmEnrollmentToken("org-1", "vm-1")).resolves.toEqual({
      tokenId: "token-1",
      token: "ENR_test-token",
      expiresAt: "2026-10-02T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/organizations/org-1/vms/vm-1/enrollment-token",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("does not infer Linux when the API has no OS value", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [
        {
          id: "vm-pending",
          organizationId: "org-1",
          hostname: "pending-agent-01",
          ipAddress: null,
          os: null,
          status: "DISCONNECTED",
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T01:00:00.000Z",
          tags: [],
          agent: null,
        },
      ],
      page: 1,
      pageSize: 100,
      total: 1,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const vms = await getVms("org-1");

    expect(vms[0]).toEqual(expect.objectContaining({
      id: "vm-pending",
      osType: "Unknown",
      osVersion: "Unknown",
    }));
  });
});
