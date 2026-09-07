# v0.5 flow validation (2026-09-07)

Not an A/B run. The A/B protocol needs the subject team's staging app and a
hand-written suite to compare against; neither is available outside that
team. This run answers a narrower question before release: **does a test
written only from session outputs run green, and what does the tool get
wrong?** The fixture and every artifact are in [flow/](flow/).

## Setup

- `flow/app.mjs`: a fixture mirroring the first A/B subject (seller-dashboard
  login). Ant Design-style empty `role=alert` with the toast text in a
  sibling, `POST /api/auth/login` returning 401 then 200, redirect to
  `/dashboard`, a welcome dialog rendered 700 ms after landing, an account
  menu with `menuitem`s, logout redirecting to `/login`.
- `flow/drive.mjs`: an MCP client over stdio against `dist/index.js`, walking
  `session_open` → `session_extract` → `session_act` (wrong password) →
  diff → `session_act` (right password) → diff → `session_act` (close
  dialog, open menu) → diff → `session_act` (logout) → `session_close`.
- `flow/login.spec.ts`: two Playwright tests written from those outputs only,
  per `conventions://playwright`.
- `flow/summary.json`: the recorded facts and payload sizes.

## Result

| Metric | Value |
| --- | --- |
| Generated tests green, unmodified | 2 / 2 |
| Behavioral iterations needed | 0 (redirect targets and API paths came from `observed`) |
| Locator-caused failures | 0 |
| Context cost, whole flow (10 calls, 4 snapshots) | ~10,600 est. tokens |
| Same flow as 4 full extractions (first A/B trace) | ~16,600 est. tokens |
| Flow wall time inside the server | 2.2 s |

The two behavioral iterations from the first A/B run (post-logout redirect
target, late welcome modal) did not recur: the redirect was in
`observed.navigations`, and `wait_selector_after` on the dialog's close
button made the late modal deterministic.

## What the run found in the tool

Running the generated test is what exposed these; the Vitest suite had not.

1. **`is_visible` disagreed with Playwright.** The empty live region has
   width but zero height. The extractor called it visible; `toBeVisible()`
   failed. Root cause: three visibility rules (both dimensions zero,
   `opacity:0`, `aria-hidden`) that Playwright does not use. `is_visible` now
   follows Playwright's `computeBox` rule exactly.
2. **Diff identity broke on hidden → visible.** Hidden menu items resolve to
   `getByText` (role locators skip hidden elements), visible ones to
   `getByRole`, so the diff showed 3 removed + 3 added instead of 3 changed.
   Identity is now test-id → id → placeholder → tag + role + accessible name,
   and the locator switch is reported as a change.
3. **Short secrets collided with page copy.** The test password `salah` was
   scrubbed out of the toast text "Email atau kata sandi salah". Redaction
   now applies to values of 8+ characters only.
4. **A completed fetch aborted by navigation was marked failed.** The logout
   POST had `status: 200` and `failed: net::ERR_ABORTED`. A failure is now
   recorded only when no response arrived.

## Reproduce

```bash
npm run build
node benchmark/flow/app.mjs &
node benchmark/flow/drive.mjs
```

To run `login.spec.ts`, install `@playwright/test@1.61.1` in a scratch
directory with a config whose `baseURL` is `http://127.0.0.1:4177`.
