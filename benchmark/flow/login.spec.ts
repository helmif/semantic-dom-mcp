// Written ONLY from the drive.mjs outputs (session extractions + diffs +
// observed behavior), following conventions://playwright. Every locator below
// exists in the extraction output; every waitForResponse / toHaveURL target
// comes from `observed`, not from memory. Runs with @playwright/test against
// app.mjs (baseURL http://127.0.0.1:4177); it is a reference, not part of the
// Vitest suite.
import { expect, test } from "@playwright/test";

test.describe("Seller Center login", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("shows an error toast on wrong credentials", async ({ page }) => {
    // Arrange (02-login-full: fields required, alert hidden)
    await expect(page.getByTestId("login-email")).toBeVisible();
    await expect(page.getByTestId("login-password")).toBeVisible();
    await expect(page.getByRole("alert")).toBeHidden();

    // Act (03-bad-login-act observed: POST /api/auth/login → 401, no navigation)
    await page.getByTestId("login-email").fill("budi@toko.id");
    await page.getByTestId("login-password").fill("salah");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.request().method() === "POST"),
      page.getByTestId("login-submit").click(),
    ]);
    expect(res.status()).toBe(401);

    // Assert (04-bad-login-diff changed: alert text_content borrowed from the
    // enclosing container, is_visible stays false — the live region is empty
    // and zero-height, so the context_note says to assert on the container)
    await expect(page.getByRole("alert")).toBeAttached();
    await expect(page.getByRole("alert").locator("..")).toContainText("Email atau kata sandi salah");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("login-email")).toHaveValue("budi@toko.id");
  });

  test("logs in, dismisses the welcome dialog, opens the account menu and logs out", async ({ page }) => {
    // Act: login (05-good-login-act observed: POST /api/auth/login → 200, /login → /dashboard)
    await page.getByTestId("login-email").fill("budi@toko.id");
    await page.getByTestId("login-password").fill("rahasia123");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.request().method() === "POST"),
      page.getByTestId("login-submit").click(),
    ]);
    expect(res.status()).toBe(200);
    await expect(page).toHaveURL(/\/dashboard$/);

    // Assert: late welcome dialog (06-dashboard-diff added: dialog, unique role locator)
    const welcome = page.getByRole("dialog", { name: "Selamat datang" });
    await expect(welcome).toBeVisible();
    await expect(page.getByTestId("orders-link")).toBeVisible();
    await expect(page.getByRole("link", { name: "Seller Center" })).toHaveAttribute("href", "/dashboard");

    // Act: close dialog, open menu (07-menu-act; 08-menu-diff changed:
    // account-menu aria_expanded false→true, logout is_visible false→true)
    await page.getByTestId("welcome-close").click();
    await expect(welcome).toBeHidden();
    await page.getByTestId("account-menu").click();
    await expect(page.getByTestId("account-menu")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("menuitem", { name: "Profil" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Pengaturan" })).toBeVisible();
    // New-tab link: assert the href instead of choreographing a popup (schema 1.1 href)
    await expect(page.getByRole("menuitem", { name: "Bantuan" })).toHaveAttribute("href", "/help");
    await expect(page.getByTestId("logout")).toBeVisible();

    // Act: logout (09-logout-act observed: POST /api/auth/logout → 200, /dashboard → /login)
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/logout") && r.request().method() === "POST"),
      page.getByTestId("logout").click(),
    ]);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("login-form")).toBeVisible();
  });
});
