import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkUrlAllowed } from "../src/browser.js";

describe("URL scheme + host allowlist", () => {
  let savedHosts: string | undefined;

  beforeEach(() => {
    savedHosts = process.env.QA_MCP_ALLOWED_HOSTS;
  });

  afterEach(() => {
    if (savedHosts === undefined) delete process.env.QA_MCP_ALLOWED_HOSTS;
    else process.env.QA_MCP_ALLOWED_HOSTS = savedHosts;
  });

  it("rejects non-http(s) schemes regardless of allowlist", () => {
    process.env.QA_MCP_ALLOWED_HOSTS = "staging.example.internal";
    expect(checkUrlAllowed("file:///etc/passwd")).toMatch(/http\/https/);
    expect(checkUrlAllowed("javascript:alert(1)")).toMatch(/http\/https/);
    expect(checkUrlAllowed("data:text/html,<h1>x</h1>")).toMatch(/http\/https/);
    expect(checkUrlAllowed("not a url")).toMatch(/valid URL/);
  });

  it("denies by default when QA_MCP_ALLOWED_HOSTS is unset or empty", () => {
    delete process.env.QA_MCP_ALLOWED_HOSTS;
    expect(checkUrlAllowed("https://example.com/")).toMatch(/QA_MCP_ALLOWED_HOSTS is not set/);
    process.env.QA_MCP_ALLOWED_HOSTS = "  ,  ";
    expect(checkUrlAllowed("https://example.com/")).toMatch(/QA_MCP_ALLOWED_HOSTS is not set/);
  });

  it("allows exact hostname matches (case-insensitive) and rejects others", () => {
    process.env.QA_MCP_ALLOWED_HOSTS = "staging.shop.internal, Staging.Admin.Internal";
    expect(checkUrlAllowed("https://staging.shop.internal/checkout")).toBeNull();
    expect(checkUrlAllowed("https://STAGING.ADMIN.INTERNAL/")).toBeNull();
    expect(checkUrlAllowed("https://prod.shop.internal/")).toMatch(/not in QA_MCP_ALLOWED_HOSTS/);
    expect(checkUrlAllowed("https://evil.com/staging.shop.internal")).toMatch(/not in/);
  });

  it("supports '*.domain' wildcard and host:port pinning", () => {
    process.env.QA_MCP_ALLOWED_HOSTS = "*.staging.internal,localhost:3000";
    expect(checkUrlAllowed("https://app.staging.internal/")).toBeNull();
    expect(checkUrlAllowed("https://staging.internal/")).toBeNull();
    expect(checkUrlAllowed("https://staging.internal.evil.com/")).toMatch(/not in/);
    expect(checkUrlAllowed("http://localhost:3000/")).toBeNull();
    expect(checkUrlAllowed("http://localhost:4000/")).toMatch(/not in/);
  });
});
