import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Abliteration credit-balance probe (`GET /v1/credits`). Kept in its own file so the
 * grandfathered cap on provider-quota.test.ts stays untouched for one vendor's coverage.
 */
import {
  clearProviderQuotaCache,
  fetchProviderQuotaReports,
  providerApiKeyQuotaMode,
  setProviderQuotaBeforePublishForTests,
} from "../../src/providers/quota";
import { parseAbliterationCredits } from "../../src/providers/quota/vendor-probes-key";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let opencodexHome = "";

beforeEach(() => {
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-quota-abliteration-"));
  process.env.OPENCODEX_HOME = opencodexHome;
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearProviderQuotaCache();
  setProviderQuotaBeforePublishForTests(null);
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(opencodexHome, { recursive: true, force: true });
});

function providerConfig(baseUrl: string): OcxProviderConfig {
  return { adapter: "openai-chat", authMode: "key", baseUrl, apiKey: "abliteration-secret" } as OcxProviderConfig;
}

function keyQuotaConfig(name: string, baseUrl: string): OcxConfig {
  return { defaultProvider: name, providers: { [name]: providerConfig(baseUrl) } } as OcxConfig;
}

function creditsResponse(totalCredits: number, totalUsage: number): Response {
  return Response.json({ data: { total_credits: totalCredits, total_usage: totalUsage } });
}

describe("abliteration credits quota probe", () => {
  test("a custom-named provider on the canonical host reads /v1/credits into creditsUsd", async () => {
    const seen: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      return creditsResponse(701, 451.11472);
    }) as typeof fetch;

    const result = await fetchProviderQuotaReports(keyQuotaConfig("my-abliteration", "https://api.abliteration.ai/v1"), true);

    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]?.provider).toBe("my-abliteration");
    expect(result.reports[0]?.source).toBe("abliteration:credits");
    const credits = result.reports[0]?.quota.creditsUsd;
    expect(credits?.used).toBe(451.11472);
    expect(credits?.limit).toBe(701);
    expect(credits?.remaining).toBeCloseTo(249.88528, 6);
    expect(credits?.percent).toBeCloseTo(64.35, 2);
    expect(seen).toEqual([{
      url: "https://api.abliteration.ai/v1/credits",
      authorization: "Bearer abliteration-secret",
      redirect: "error",
    }]);
  });

  test("the bare API origin is canonical too", async () => {
    globalThis.fetch = (async () => creditsResponse(10, 2.5)) as typeof fetch;
    const result = await fetchProviderQuotaReports(keyQuotaConfig("abliteration", "https://api.abliteration.ai/"), true);
    expect(result.reports[0]?.quota.creditsUsd).toMatchObject({ used: 2.5, limit: 10, remaining: 7.5, percent: 25 });
  });

  test("never sends the key to a lookalike or non-HTTPS host", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return creditsResponse(10, 1);
    }) as typeof fetch;

    for (const baseUrl of [
      "https://api.abliteration.ai.attacker.example/v1",
      "http://api.abliteration.ai/v1",
      "https://abliteration.ai/v1",
      "https://api.abliteration.ai/v1?x=1",
    ]) {
      const result = await fetchProviderQuotaReports(keyQuotaConfig("abliteration", baseUrl), true);
      expect(result.reports).toEqual([]);
      expect(providerApiKeyQuotaMode("abliteration", providerConfig(baseUrl))).toBe("unsupported");
    }
    expect(seen).toEqual([]);
  });

  test("account rows report the canonical key as probe-capable", () => {
    expect(providerApiKeyQuotaMode("abliteration", providerConfig("https://api.abliteration.ai/v1"))).toBe("probe");
  });

  test("a rejected key drops the last-good row", async () => {
    let rejected = false;
    globalThis.fetch = (async () => rejected
      ? Response.json({ error: { code: "invalid_api_key", type: "auth_error" } }, { status: 401 })
      : creditsResponse(20, 5)) as typeof fetch;
    const config = keyQuotaConfig("abliteration", "https://api.abliteration.ai/v1");

    const valid = await fetchProviderQuotaReports(config, true);
    rejected = true;
    const invalid = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(invalid.reports).toEqual([]);
  });

  test.each([503, 429])("a transient %i keeps the last-good row", async (status) => {
    let failing = false;
    globalThis.fetch = (async () => failing
      ? Response.json({ error: { code: "credit_balance_unavailable", type: "internal_error" } }, { status, headers: { "retry-after": "5" } })
      : creditsResponse(20, 5)) as typeof fetch;
    const config = keyQuotaConfig("abliteration", "https://api.abliteration.ai/v1");

    const valid = await fetchProviderQuotaReports(config, true);
    failing = true;
    const retried = await fetchProviderQuotaReports(config, true);

    expect(valid.reports).toHaveLength(1);
    expect(retried.reports).toEqual(valid.reports);
  });

  test("spent-out balances clamp to zero remaining at 100 percent", () => {
    expect(parseAbliterationCredits({ data: { total_credits: 5, total_usage: 5.2 } })?.creditsUsd)
      .toMatchObject({ used: 5.2, limit: 5, remaining: 0, percent: 100 });
  });

  test("no credits or a malformed body produces no meter", () => {
    expect(parseAbliterationCredits({ data: { total_credits: 0, total_usage: 0 } })).toBeNull();
    expect(parseAbliterationCredits({ data: { total_credits: 10, total_usage: -1 } })).toBeNull();
    expect(parseAbliterationCredits({ data: { total_credits: "10", total_usage: null } })).toBeNull();
    expect(parseAbliterationCredits({ total_credits: 10, total_usage: 1 })).toBeNull();
    expect(parseAbliterationCredits(null)).toBeNull();
  });
});
