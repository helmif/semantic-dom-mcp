/**
 * Single source of truth for the team's Playwright test-writing conventions.
 * Surfaced two ways: the `write_playwright_test` MCP prompt and the
 * read-only `conventions://playwright` resource.
 */

export const DEFAULT_TEAM_NAME = process.env.QA_MCP_TEAM_NAME ?? "QA";

/** The non-negotiable convention block. */
export const TEAM_CONVENTIONS = `TEAM CONVENTIONS (non-negotiable):
- Locators: use ONLY the \`playwright\` expression from each node. Prefer
  primary_locator; use a fallback only if primary.is_unique is false or the
  primary is unusable, and add a comment stating why.
- If a locator has is_unique: false, apply its \`disambiguation\` guidance;
  never ship an ambiguous locator without scoping it.
- Frames: for any node with non-empty frame_path, chain frameLocator() in the
  given order before locating the element.
- Structure: use test.describe for the feature and test() per scenario;
  group actions by form_group; arrange as Arrange → Act → Assert with comments.
- Assertions: assert every stated state that is relevant to the scenario —
  is_visible, is_disabled, is_required, is_checked — using web-first
  assertions (expect(locator).toBeVisible(), toBeDisabled(), etc.).
- State changes: this JSON is a SINGLE snapshot. If an element is disabled
  now (e.g. a submit button), write the interactions that make it valid; do
  not assume it stays disabled.
- Do NOT invent selectors, ids, roles, or text not present in the data. If a
  required element for the scenario is missing, STOP and say what's missing.`;

/**
 * Renders the full `write_playwright_test` prompt body.
 */
export function renderWritePlaywrightTestPrompt(args: {
  scenario: string;
  extract_json: string;
  team_name?: string;
  framework_note?: string;
}): string {
  const teamName = args.team_name ?? DEFAULT_TEAM_NAME;
  const frameworkNote = args.framework_note ? `\n${args.framework_note}\n` : "";
  return `You are a Senior QA Automation Engineer on the ${teamName} team.
Write a Playwright test in TypeScript following OUR team conventions below.
${frameworkNote}
${TEAM_CONVENTIONS}

SCENARIO:
${args.scenario}

SEMANTIC DOM (single source of truth for locators):
\`\`\`json
${args.extract_json}
\`\`\``;
}
