import { describe, expect, it, vi } from "vitest";

import { createSiteDiscoveryRepositoryForRpc } from "../src/clients/site-discovery-repository";

describe("site discovery repository", () => {
  it("maps and validates claimed leases", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          base_domain: "agency.gov",
          initial_url: "www.agency.gov",
          lease_token: "20000000-0000-4000-8000-000000000001",
          lease_until: "2026-07-17T16:15:00.000Z",
          site_id: "10000000-0000-4000-8000-000000000001",
        },
      ],
      error: null,
    });
    const repository = createSiteDiscoveryRepositoryForRpc(rpc);

    await expect(
      repository.claim("30000000-0000-4000-8000-000000000001", 1, 900),
    ).resolves.toEqual([
      {
        baseDomain: "agency.gov",
        initialUrl: "www.agency.gov",
        leaseToken: "20000000-0000-4000-8000-000000000001",
        leaseUntil: "2026-07-17T16:15:00.000Z",
        siteId: "10000000-0000-4000-8000-000000000001",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("claim_due_site_discoveries", {
      p_claim_limit: 1,
      p_lease_seconds: 900,
      p_worker_id: "30000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects malformed rows before network orchestration", async () => {
    const repository = createSiteDiscoveryRepositoryForRpc(
      vi.fn().mockResolvedValue({
        data: [{ site_id: "not-a-uuid" }],
        error: null,
      }),
    );
    await expect(
      repository.claim("30000000-0000-4000-8000-000000000001", 1, 900),
    ).rejects.toThrow(/invalid/);
  });

  it("maps completion payloads to bounded database JSON", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const repository = createSiteDiscoveryRepositoryForRpc(rpc);
    await expect(
      repository.complete({
        feeds: [
          {
            canonicalUrl: "https://agency.gov/feed.xml",
            discoveryMethod: "html_alternate",
            discoveryUrl: "https://agency.gov/rss",
            feedType: "rss",
            homePageUrl: "https://agency.gov/",
            httpStatus: 200,
            title: "Agency news",
          },
        ],
        health: {
          durationMs: 50,
          finalUrl: "https://agency.gov/",
          httpStatus: 200,
        },
        leaseToken: "20000000-0000-4000-8000-000000000001",
        policyVersion: 1,
        result: "succeeded",
        siteId: "10000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "complete_site_discovery",
      expect.objectContaining({
        p_feeds: [
          expect.objectContaining({
            canonical_url: "https://agency.gov/feed.xml",
            discovery_method: "html_alternate",
          }),
        ],
        p_site_health: {
          duration_ms: 50,
          final_url: "https://agency.gov/",
          http_status: 200,
        },
      }),
    );
  });

  it("never includes database error details in thrown messages", async () => {
    const repository = createSiteDiscoveryRepositoryForRpc(
      vi.fn().mockResolvedValue({
        data: null,
        error: { code: "PGRST500", message: "secret database detail" },
      }),
    );
    await expect(repository.summary()).rejects.toThrow(
      "Supabase RPC get_site_discovery_summary failed with code PGRST500",
    );
    await expect(repository.summary()).rejects.not.toThrow(
      /secret database detail/,
    );
  });
});
