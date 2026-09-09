import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeBrowser } from "../src/browser.js";
import { createServer } from "../src/server.js";
import { closeAllSessions } from "../src/session.js";
import { htmlPage, startFixtureServer, type FixtureServer } from "./helpers.js";

/* End-to-end through the MCP surface: what a client actually receives.
 * The other suites validate the internal shape; this one pins the WIRE. */

let fx: FixtureServer;
let client: Client;

beforeAll(async () => {
  fx = await startFixtureServer();
  process.env.QA_MCP_ALLOWED_HOSTS = "127.0.0.1";
  delete process.env.QA_MCP_STORAGE_STATE;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "wire-test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await closeAllSessions();
  await closeBrowser();
  await fx.close();
});

async function callText(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
}

describe("MCP wire format (schema 1.5)", () => {
  it("emits compact JSON with no null node fields, no indentation, and the documented omissions", async () => {
    fx.route(
      "/wire",
      htmlPage(`
        <form id="f"><label for="e">Email</label><input id="e" data-testid="email" type="email" required>
        <button data-testid="go">Kirim</button><button data-testid="go">Kirim</button></form>`),
    );
    const { text, isError } = await callText("extract_semantic_dom", { url: `${fx.base}/wire` });
    expect(isError).toBe(false);
    expect(text).not.toContain("\n"); // compact, not pretty-printed
    expect(text).not.toMatch(/:null[,}]/); // no null node fields on the wire
    expect(text).not.toContain('"identity"'); // internal only
    const doc = JSON.parse(text) as { schema_version: string; interactive_nodes: Array<Record<string, unknown>> };
    expect(doc.schema_version).toBe("1.5");
    const email = doc.interactive_nodes.find((n) => (n.primary_locator as { playwright: string }).playwright === "getByTestId('email')")!;
    expect(email).not.toHaveProperty("kind");
    expect(email).not.toHaveProperty("frame_path");
    expect(email).not.toHaveProperty("in_shadow");
    expect(email).not.toHaveProperty("fallback_locators"); // unique primary
    expect(email.properties).toMatchObject({ is_visible: true, is_required: true, type: "email" });
    expect(email.properties).not.toHaveProperty("href");
    // Ambiguous primaries keep their fallbacks and guidance.
    const gos = doc.interactive_nodes.filter((n) => (n.primary_locator as { playwright: string }).playwright === "getByTestId('go')");
    expect(gos).toHaveLength(2);
    for (const go of gos) {
      expect((go.primary_locator as { is_unique: boolean }).is_unique).toBe(false);
      expect(go).toHaveProperty("fallback_locators");
    }
  });

  it("compacts the extraction nested in a session_act then_extract report", async () => {
    fx.route("/act-wire", htmlPage(`<button data-testid="go" onclick="document.body.insertAdjacentHTML('beforeend','<div role=alert>Oke</div>')">Go</button>`));
    const open = JSON.parse((await callText("session_open", { url: `${fx.base}/act-wire`, wait_for: "load" })).text) as { session_id: string };
    await callText("session_extract", { session_id: open.session_id });
    const { text } = await callText("session_act", {
      session_id: open.session_id,
      actions: [{ type: "click", locator: { playwright: "getByTestId('go')" } }],
      settle_ms: 100,
      then_extract: { mode: "diff" },
    });
    expect(text).not.toContain("\n");
    expect(text).not.toMatch(/:null[,}]/);
    expect(text).not.toContain("nth-child(");
    const report = JSON.parse(text) as { extract: { kind: string; added: Array<{ role: string }> } };
    expect(report.extract.kind).toBe("diff");
    expect(report.extract.added.map((n) => n.role)).toEqual(["alert"]);
    await callText("session_close", { session_id: open.session_id });
  });

  it("lists the tools with annotations and returns structured errors for bad input", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "check_auth", "extract_outline", "extract_semantic_dom", "extract_semantic_dom_after", "get_conventions", "list_frames",
        "session_act", "session_close", "session_extract", "session_list", "session_open", "session_verify_locators", "verify_locators",
      ].sort(),
    );
    expect(tools.find((t) => t.name === "extract_semantic_dom")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.find((t) => t.name === "session_extract")?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: false });
    const denied = await callText("extract_semantic_dom", { url: "https://example.com/" });
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.text)).toMatchObject({ error: "url_not_allowed" });
  });
});
