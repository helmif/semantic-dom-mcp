import { describe, expect, it } from "vitest";
import { LocatorParseError, parseLocatorExpression } from "../src/locatorExpr.js";

/* The grammar must round-trip every expression the extractor emits and reject
 * everything else with a structured error (it is not eval). */

describe("parseLocatorExpression", () => {
  it("parses every emitted form, scoped forms and .nth", () => {
    expect(parseLocatorExpression("getByTestId('login-email')")).toEqual({ strategy: "test-id", value: "login-email" });
    expect(parseLocatorExpression("getByRole('alert')")).toEqual({ strategy: "role", role: "alert", value: "" });
    expect(parseLocatorExpression("getByRole('button', { name: 'Tambah ke Keranjang' }).nth(1)")).toEqual({
      strategy: "role",
      role: "button",
      value: "Tambah ke Keranjang",
      nth: 1,
    });
    expect(parseLocatorExpression("getByLabel('Kata sandi')")).toEqual({ strategy: "label", value: "Kata sandi" });
    expect(parseLocatorExpression("getByPlaceholder('0')")).toEqual({ strategy: "placeholder", value: "0" });
    expect(parseLocatorExpression("getByText('Dhana\\'s Pokemon Store')")).toEqual({ strategy: "text", value: "Dhana's Pokemon Store" });
    expect(parseLocatorExpression("locator('#user-email')")).toEqual({ strategy: "css", value: "#user-email" });
    expect(parseLocatorExpression("getByRole('row', { name: 'Charizard' }).getByPlaceholder('0')")).toEqual({
      strategy: "placeholder",
      value: "0",
      within: { kind: "row", value: "Charizard" },
    });
    expect(parseLocatorExpression("getByRole('listitem').filter({ hasText: 'Puthera' }).getByRole('button', { name: 'Pilih Pembeli Ini' })")).toEqual({
      strategy: "role",
      role: "button",
      value: "Pilih Pembeli Ini",
      within: { kind: "listitem", value: "Puthera" },
    });
    expect(parseLocatorExpression("getByTestId('customer-checkbox-flex').getByRole('checkbox')")).toEqual({
      strategy: "role",
      role: "checkbox",
      value: "",
      within: { kind: "test-id", value: "customer-checkbox-flex" },
    });
  });

  it("rejects anything outside the grammar", () => {
    for (const bad of [
      "page.getByRole('button')",
      "getByRole('button').click()",
      "locator('div').first()",
      "getByRole(\"button\")",
      "getByText('x').filter({ hasText: 'y' })",
      "eval('1')",
    ]) {
      expect(() => parseLocatorExpression(bad)).toThrow(LocatorParseError);
    }
  });
});

describe("css scope prefix", () => {
  it("parses locator('<selector>').<inner> as a css scope", () => {
    expect(parseLocatorExpression("locator('[role=dialog]').getByRole('button', { name: 'Batal' })")).toEqual({
      strategy: "role",
      role: "button",
      value: "Batal",
      within: { kind: "css", value: "[role=dialog]" },
    });
    expect(parseLocatorExpression("locator('#stock').getByPlaceholder('0').nth(1)")).toEqual({ strategy: "placeholder", value: "0", nth: 1, within: { kind: "css", value: "#stock" } });
  });
});
