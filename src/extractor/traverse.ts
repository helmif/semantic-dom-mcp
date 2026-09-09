/**
 * IN-PAGE extraction engine: forest traversal, node
 * selection, visibility resolution, accessible name, properties, form
 * grouping, caps + truncation flagging, and locator *candidate* data.
 *
 * CRITICAL CONSTRAINT: every function in this file is stringified via
 * `Function.prototype.toString()` and injected into the browser page by
 * inPage.ts. Therefore these functions must be fully self-contained:
 *   - no imports, no references to module-level values,
 *   - they may only call each other by name (they are concatenated into one
 *     scope) and use standard DOM/JS globals,
 *   - no TypeScript runtime features that require helpers.
 *
 * Locator uniqueness is NOT computed here — that happens at the Playwright
 * layer (locators.ts) using Playwright's real selector engine, so counts
 * exactly match the emitted `getBy*` expressions.
 */

/** Candidate locator data gathered in-page; expressions are built server-side. */
export interface RawScope {
  kind: "row" | "listitem" | "test-id" | "css";
  value: string;
}

export interface RawLocatorCandidate {
  strategy: "test-id" | "role" | "label" | "placeholder" | "text" | "id" | "css";
  value: string;
  /** Only for strategy "role". */
  role?: string;
  /** Container to scope the expression to (row / list item / test-id ancestor). */
  within?: RawScope;
  /**
   * Structural-CSS-path candidates are brittle and may only become the
   * primary locator when NO other candidate exists (css is the last
   * resort, only if nothing above is usable).
   */
  last_resort?: boolean;
}

export interface RawNodeProperties {
  type: string | null;
  placeholder: string | null;
  text_content: string | null;
  href: string | null;
  is_required: boolean | null;
  is_disabled: boolean | null;
  is_checked: boolean | null;
  is_visible: boolean;
  // schema 1.2 — assertable state
  value: string | null;
  aria_expanded: boolean | null;
  aria_selected: boolean | null;
  aria_invalid: boolean | null;
  described_by: string | null;
  validation_message: string | null;
  options: Array<{ value: string; label: string; selected: boolean }> | null;
}

export interface RawNode {
  kind: "element" | "shadow_boundary";
  tag: string;
  role: string | null;
  in_shadow: boolean;
  form_group: string | null;
  accessible_name: string | null;
  /** Priority-ordered locator candidates. */
  candidates: RawLocatorCandidate[];
  /** Nearest ancestor data-testid, for disambiguation scoping guidance. */
  scope_hint: string | null;
  /**
   * Stable identity for snapshot diffs, from the element's own attributes
   * (test attribute > human-authored id > placeholder > tag|role|name). Never
   * derived from which locators happened to be verified. Not emitted.
   */
  identity: string;
  /**
   * Structural CSS path from the document root, used server-side only to
   * correlate the element with Playwright locator matches (.nth index).
   * Empty for shadow-DOM nodes — a within-shadow structural path is exactly
   * the kind of shadow-piercing CSS this tool must never emit.
   */
  css_path: string;
  properties: RawNodeProperties;
  context_note?: string;
}

export interface RawExtractResult {
  nodes: RawNode[];
  truncated: boolean;
  notes: string[];
}

export interface InPageOptions {
  maxNodes: number;
  maxDepth: number;
  /** Opt-in heuristic: include cursor:pointer boundary elements with content
   * (JS-click cards) that match no other inclusion rule. */
  includeClickTargets?: boolean;
  /** CSS selector of the element to extract within (first match); the rest of the page is skipped. */
  scopeSelector?: string;
  /** Keep only nodes whose role or tag is listed. */
  roles?: string[];
  /** Skip hidden nodes in-page (cheaper than filtering after locator verification). */
  visibleOnly?: boolean;
}

/** Inherited ancestor visibility flags carried down the traversal stack. */
interface AncestorFlags {
  displayNone: boolean;
}

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

export function __qaCollapse(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

export function __qaTextContent(el: Element): string {
  var t = __qaCollapse(el.textContent);
  if (t.length > 120) t = t.slice(0, 120);
  return t;
}

/* ------------------------------------------------------------------ */
/* Role (explicit role attribute, else a small implicit mapping         */
/* aligned with Playwright's getByRole for common controls)             */
/* ------------------------------------------------------------------ */

export function __qaRole(el: Element): string | null {
  var explicit = __qaCollapse(el.getAttribute("role"));
  if (explicit) return explicit.split(" ")[0]!;
  var tag = el.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "dialog") return "dialog";
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (tag === "select") {
    var sel = el as HTMLSelectElement;
    return sel.multiple || sel.size > 1 ? "listbox" : "combobox";
  }
  if (tag === "textarea") return "textbox";
  if (tag === "option") return "option";
  if (tag === "input") {
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type === "hidden") return null;
    // text, email, tel, url, password and unknown types behave as textbox
    return "textbox";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Label association & accessible name                                  */
/* (precedence: aria-labelledby > aria-label > <label> > text)          */
/* ------------------------------------------------------------------ */

/**
 * Joined, collapsed text of the elements an ID-reference attribute
 * (aria-labelledby, aria-describedby) points at; null when nothing resolves.
 * Ids are resolved in the element's own root (document or shadow root).
 */
export function __qaIdRefsText(el: Element, attr: string): string | null {
  var raw = el.getAttribute(attr);
  if (!raw) return null;
  var root = el.getRootNode() as Document | ShadowRoot;
  var parts: string[] = [];
  var ids = raw.split(/\s+/);
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i]) continue;
    var ref = root.getElementById ? root.getElementById(ids[i]!) : null;
    if (ref) {
      var t = __qaCollapse(ref.textContent);
      if (t) parts.push(t);
    }
  }
  var joined = __qaCollapse(parts.join(" "));
  return joined || null;
}

export function __qaLabelText(el: Element): string | null {
  var labelledBy = __qaIdRefsText(el, "aria-labelledby");
  if (labelledBy) return labelledBy;
  // native label association (label[for] / wrapping label)
  var labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    var t = __qaCollapse(labels[0]!.textContent);
    if (t) return t;
  }
  var wrapping = el.closest ? el.closest("label") : null;
  if (wrapping) {
    var wt = __qaCollapse(wrapping.textContent);
    if (wt) return wt;
  }
  return null;
}

export function __qaAccessibleName(el: Element): string | null {
  // accname precedence (and Playwright's): aria-labelledby, then aria-label,
  // then the associated <label>, then content.
  var labelledBy = __qaIdRefsText(el, "aria-labelledby");
  if (labelledBy) return labelledBy;
  var ariaLabel = __qaCollapse(el.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;
  var labelText = __qaLabelText(el);
  if (labelText) return labelText;
  var tag = el.tagName.toLowerCase();
  if (tag === "input") {
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") {
      var v = __qaCollapse((el as HTMLInputElement).value);
      if (v) return v;
    }
    if (type === "image") {
      var alt = __qaCollapse(el.getAttribute("alt"));
      if (alt) return alt;
    }
    return null; // unlabeled form field has no accessible name here
  }
  if (tag === "select" || tag === "textarea") return null;
  var text = __qaTextContent(el);
  if (text) return text;
  // Image-only elements (logo links, icon buttons): the image alt is the
  // text equivalent — without it these fall to brittle structural CSS.
  var img = el.querySelector ? el.querySelector("img[alt]") : null;
  if (img) {
    var imgAlt = __qaCollapse(img.getAttribute("alt"));
    if (imgAlt) return imgAlt;
  }
  // Inline icons: <svg aria-label> or <svg><title> is the accessible text.
  var svg = el.querySelector ? el.querySelector("svg") : null;
  if (svg) {
    var svgLabel = __qaCollapse(svg.getAttribute("aria-label"));
    if (svgLabel) return svgLabel;
    var title = svg.querySelector("title");
    var svgTitle = title ? __qaCollapse(title.textContent) : "";
    if (svgTitle) return svgTitle;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Form grouping                                                        */
/* ------------------------------------------------------------------ */

export function __qaFormGroup(el: Element): string | null {
  var form = el.closest ? (el.closest("form") as HTMLFormElement | null) : null;
  if (form) {
    if (form.id) return "form#" + form.id;
    var name = form.getAttribute("name");
    if (name) return 'form[name="' + name + '"]';
    var idx = Array.prototype.indexOf.call(document.forms, form);
    return "form:nth(" + (idx >= 0 ? idx : 0) + ")";
  }
  var region = el.closest ? el.closest('[role="form"], section') : null;
  if (region) {
    var rTag = region.tagName.toLowerCase();
    var base = region.getAttribute("role") === "form" ? rTag + '[role="form"]' : rTag;
    if (region.id) return base + "#" + region.id;
    var aria = __qaCollapse(region.getAttribute("aria-label"));
    if (aria) return base + '[aria-label="' + aria + '"]';
    return base;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Structural CSS path (document tree only; correlation, never shadow)  */
/* ------------------------------------------------------------------ */

export function __qaCssPath(el: Element): string {
  var parts: string[] = [];
  var cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    var parent: Element | null = cur.parentElement;
    if (!parent) return ""; // detached or inside a shadow root — no document path
    var index = 1;
    var sib = cur.previousElementSibling;
    while (sib) {
      index++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(cur.tagName.toLowerCase() + ":nth-child(" + index + ")");
    cur = parent;
  }
  if (cur !== document.documentElement) return "";
  parts.unshift("html");
  return parts.join(" > ");
}

/* ------------------------------------------------------------------ */
/* Node selection — include if ANY match                                */
/* ------------------------------------------------------------------ */

/**
 * Framework-generated ids (Ant/rc, React useId, Radix, MUI, Ember, jQuery UI,
 * select2...) change between builds or render orders — locators built on them
 * are flaky by construction and must never be a primary locator.
 */
export function __qaIsGeneratedId(id: string): boolean {
  if (/^:r[0-9a-z]+:?$/i.test(id)) return true; // React 18 useId
  return /^(rc[-_]|react-|radix-|headlessui-|downshift-|mui[-_]|ember\d|select2-|ui-id-)/i.test(id);
}

export function __qaTestAttr(el: Element): { attr: string; value: string } | null {
  var attrs = ["data-testid", "data-cy", "data-qa", "data-test"];
  for (var i = 0; i < attrs.length; i++) {
    var v = el.getAttribute(attrs[i]!);
    if (v !== null && v !== "") return { attr: attrs[i]!, value: v };
  }
  return null;
}

export function __qaShouldInclude(el: Element, role: string | null): boolean {
  if (__qaTestAttr(el)) return true;
  var tag = el.tagName.toLowerCase();
  var nativeInteractive =
    tag === "input" || tag === "button" || tag === "a" || tag === "select" || tag === "textarea";
  if (nativeInteractive) return true;
  // A <label> is a control only when it carries text; a textless wrapper
  // around a checkbox (component libraries) is the checkbox's chrome.
  if (tag === "label") return !!__qaCollapse(el.textContent);
  var formAssociated = tag === "option" || tag === "fieldset" || tag === "output" || tag === "legend";
  if (el.id && (nativeInteractive || formAssociated)) return true;
  var roleList = [
    "button", "link", "checkbox", "radio", "tab", "menuitem",
    "switch", "combobox", "textbox", "option",
    // Notification and
    // dialog surfaces are test-relevant even though they aren't interactive —
    // tests assert toasts, validation banners, and modals constantly.
    "alert", "status", "alertdialog", "dialog",
  ];
  if (role && roleList.indexOf(role) >= 0) return true;
  // Non-default tabindex marks a custom focusable control. tabindex="-1" is
  // excluded: it is common on containers for programmatic focus, not controls.
  // A focusable element with no role, no name and no content is a focus-trap
  // sentinel (dialog libraries place one at each end of a modal), not a
  // control: it would only yield a structural CSS locator nobody can use.
  var ti = el.getAttribute("tabindex");
  if (ti !== null) {
    var n = parseInt(ti, 10);
    if (!isNaN(n) && n >= 0) {
      // Any explicit role (slider, treeitem, gridcell...) is a widget, in the
      // interactive list or not.
      if (role) return true;
      if (__qaCollapse(el.getAttribute("aria-label")) || __qaIdRefsText(el, "aria-labelledby") || __qaCollapse(el.getAttribute("title"))) return true;
      return __qaHasContent(el);
    }
  }
  return false;
}

/**
 * Identity for diffs (see RawNode.identity). Generated ids are skipped: they
 * change between builds and would pair nothing.
 */
export function __qaIdentity(el: Element, role: string | null, accessibleName: string | null): string {
  var attr = __qaTestAttr(el);
  if (attr) return attr.attr + "=" + attr.value;
  if (el.id && !__qaIsGeneratedId(el.id)) return "id=" + el.id;
  var placeholder = __qaCollapse(el.getAttribute("placeholder"));
  if (placeholder) return "placeholder=" + placeholder;
  return el.tagName.toLowerCase() + "|" + (role || "") + "|" + (accessibleName || "");
}

/* ------------------------------------------------------------------ */
/* Properties & visibility                                              */
/* ------------------------------------------------------------------ */

/**
 * `is_visible` predicts `expect(locator).toBeVisible()`, so it follows
 * Playwright's own rule: not display:none (self or ancestor), `visibility`
 * not hidden/collapse, and a bounding box with BOTH width and height > 0
 * (`display: contents` delegates to its children). Opacity and aria-hidden
 * do not count for Playwright's visibility and therefore not here either.
 */
export function __qaVisibility(el: Element, anc: AncestorFlags): {
  visible: boolean;
  self: AncestorFlags;
  pointer: boolean;
} {
  var cs = window.getComputedStyle(el);
  var self: AncestorFlags = { displayNone: anc.displayNone || cs.display === "none" };
  var hidden = self.displayNone;
  if (!hidden && (cs.visibility === "hidden" || cs.visibility === "collapse")) hidden = true;
  if (!hidden) hidden = !__qaHasBox(el, cs);
  return { visible: !hidden, self: self, pointer: cs.cursor === "pointer" };
}

/** Playwright's box test: width and height both > 0; display:contents looks at children. */
export function __qaHasBox(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display === "contents") {
    for (var child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && __qaHasBox(child as Element, window.getComputedStyle(child as Element))) return true;
      if (child.nodeType === 3) {
        var range = document.createRange();
        range.selectNode(child);
        var tr = range.getBoundingClientRect();
        if (tr.width > 0 && tr.height > 0) return true;
      }
    }
    return false;
  }
  var rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * For click-target heuristic nodes: a short heading inside the element (a
 * product-card title, typically) makes a usable getByText candidate. Returns
 * null when there is no heading or it is too long to be a stable text match.
 */
export function __qaClickTargetHeading(el: Element): string | null {
  var h = el.querySelector ? el.querySelector("h1,h2,h3,h4,h5,h6") : null;
  if (!h) return null;
  var t = __qaCollapse(h.textContent);
  return t && t.length <= 80 ? t : null;
}

/** Content = text, an image, or an inline icon; empty pointer divs are decoration. */
export function __qaHasContent(el: Element): boolean {
  if (__qaCollapse(el.textContent)) return true;
  return !!(el.querySelector && el.querySelector("img, svg"));
}

export function __qaProperties(el: Element, visible: boolean): RawNodeProperties {
  var tag = el.tagName.toLowerCase();
  var isFormField = tag === "input" || tag === "select" || tag === "textarea";

  var type: string | null = null;
  if (tag === "input") type = ((el as HTMLInputElement).type || "text").toLowerCase();
  else if (tag === "button") type = ((el as HTMLButtonElement).type || "submit").toLowerCase();
  else if (el.getAttribute("type")) type = el.getAttribute("type");

  var placeholder = el.getAttribute("placeholder");

  // Absolute href for links so agents can discover navigable pages (1.1).
  var href: string | null = null;
  if (tag === "a" && el.hasAttribute("href")) {
    var rawHref = (el as HTMLAnchorElement).href;
    if (rawHref && !/^javascript:/i.test(rawHref)) {
      href = rawHref.length > 300 ? rawHref.slice(0, 300) : rawHref;
    }
  }

  var text: string | null = null;
  if (!isFormField) {
    var t = __qaTextContent(el);
    text = t || null;
  }

  var required: boolean | null = null;
  if (isFormField) required = (el as HTMLInputElement).required === true;
  else if (el.getAttribute("aria-required") !== null) required = el.getAttribute("aria-required") === "true";

  var disabled: boolean | null = null;
  if ("disabled" in el && typeof (el as HTMLInputElement).disabled === "boolean") {
    disabled = (el as HTMLInputElement).disabled;
    if (!disabled && el.getAttribute("aria-disabled") === "true") disabled = true;
  } else if (el.getAttribute("aria-disabled") !== null) {
    disabled = el.getAttribute("aria-disabled") === "true";
  }

  var checked: boolean | null = null;
  if (tag === "input") {
    var it = ((el as HTMLInputElement).type || "").toLowerCase();
    if (it === "checkbox" || it === "radio") checked = (el as HTMLInputElement).checked;
  } else {
    var ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked === "true") checked = true;
    else if (ariaChecked === "false") checked = false;
    // aria-checked="mixed" stays null (tri-state has no boolean answer)
  }

  // --- schema 1.2: assertable state -----------------------------------

  // Current value. Credential fields are NEVER surfaced: password type, and
  // autocomplete tokens that mark passwords, one-time codes and card data
  // (a "show password" toggle turns type=password into type=text; the token
  // survives that). checkbox/radio values are static attributes, not state.
  var value: string | null = null;
  if (isFormField) {
    var vt = tag === "input" ? ((el as HTMLInputElement).type || "text").toLowerCase() : "";
    var ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    var credential =
      vt === "password" || /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)(\s|$)/.test(ac);
    if (!credential && vt !== "checkbox" && vt !== "radio" && vt !== "file" && vt !== "hidden") {
      var rawValue = (el as HTMLInputElement).value;
      if (typeof rawValue === "string") value = rawValue.length > 200 ? rawValue.slice(0, 200) : rawValue;
    }
  }

  var expanded = __qaAriaBool(el.getAttribute("aria-expanded"));
  var selected = __qaAriaBool(el.getAttribute("aria-selected"));
  if (selected === null && tag === "option") selected = (el as HTMLOptionElement).selected;
  // aria-invalid: true | grammar | spelling → invalid; false → valid; empty or
  // unknown tokens mean "not set" per ARIA and stay null.
  var invalidAttr = el.getAttribute("aria-invalid");
  var invalid: boolean | null = null;
  if (invalidAttr === "true" || invalidAttr === "grammar" || invalidAttr === "spelling") invalid = true;
  else if (invalidAttr === "false") invalid = false;

  // aria-describedby is where hint text and validation messages live.
  var describedBy = __qaIdRefsText(el, "aria-describedby");
  if (describedBy && describedBy.length > 200) describedBy = describedBy.slice(0, 200);

  // Constraint-validation message, only when the browser says the field is invalid.
  var validationMessage: string | null = null;
  if (isFormField) {
    var fe = el as HTMLInputElement;
    if (fe.validity && !fe.validity.valid && fe.validationMessage) {
      validationMessage = __qaCollapse(fe.validationMessage) || null;
    }
  }

  var options: Array<{ value: string; label: string; selected: boolean }> | null = null;
  if (tag === "select") {
    options = [];
    var opts = (el as HTMLSelectElement).options;
    for (var oi = 0; oi < opts.length && oi < 50; oi++) {
      var o = opts[oi]!;
      options.push({ value: o.value, label: __qaCollapse(o.label || o.textContent), selected: o.selected });
    }
  }

  return {
    type: type,
    placeholder: placeholder,
    text_content: text,
    href: href,
    is_required: required,
    is_disabled: disabled,
    is_checked: checked,
    is_visible: visible,
    value: value,
    aria_expanded: expanded,
    aria_selected: selected,
    aria_invalid: invalid,
    described_by: describedBy,
    validation_message: validationMessage,
    options: options,
  };
}

/** "true" → true, "false" → false, anything else (absent, "undefined") → null. */
export function __qaAriaBool(attr: string | null): boolean | null {
  if (attr === "true") return true;
  if (attr === "false") return false;
  return null;
}

/* ------------------------------------------------------------------ */
/* Locator candidates (priority order)                                  */
/* ------------------------------------------------------------------ */

export function __qaCandidates(
  el: Element,
  role: string | null,
  accessibleName: string | null,
  inShadow: boolean,
  cssPath: string,
  rootScope?: RawScope | null,
): { candidates: RawLocatorCandidate[]; note: string | null } {
  var out: RawLocatorCandidate[] = [];
  var noteParts: string[] = [];
  var tag = el.tagName.toLowerCase();
  var isFormField = tag === "input" || tag === "select" || tag === "textarea";

  var testId = el.getAttribute("data-testid");
  if (testId) out.push({ strategy: "test-id", value: testId });

  // Other test attributes can't feed getByTestId (default testIdAttribute is
  // data-testid) — surface them as a stable attribute-CSS candidate instead.
  var alt = __qaTestAttr(el);
  if (alt && alt.attr !== "data-testid") {
    out.push({ strategy: "css", value: "[" + alt.attr + '="' + alt.value.replace(/"/g, '\\"') + '"]' });
    noteParts.push(
      alt.attr +
        " present; getByTestId only reads data-testid unless the team configures testIdAttribute to " +
        alt.attr +
        ".",
    );
  }

  // ARIA alert/status/dialog roles do NOT take their accessible name from
  // contents, so getByRole(role, { name: <text> }) would never match. Emit
  // the author-provided name when present, else a bare getByRole(role).
  var authorNamedOnly = ["alert", "status", "alertdialog", "dialog"];
  if (role && authorNamedOnly.indexOf(role) >= 0) {
    var authorName = __qaCollapse(el.getAttribute("aria-label")) || __qaLabelText(el) || "";
    out.push({ strategy: "role", value: authorName, role: role });
  } else if (role && accessibleName) {
    out.push({ strategy: "role", value: accessibleName, role: role });
  }

  // getByLabel resolves aria-labelledby, else aria-label, else <label> text —
  // that order is Playwright's, so the candidate must follow it or count 0.
  // When the role candidate already carries the same name the label locator
  // would match the same set; skip it rather than spend a round trip.
  var labelText = __qaIdRefsText(el, "aria-labelledby") || __qaCollapse(el.getAttribute("aria-label")) || __qaLabelText(el);
  var roleCarriesName = role && accessibleName && accessibleName === labelText && authorNamedOnly.indexOf(role) < 0;
  if (labelText && !roleCarriesName) out.push({ strategy: "label", value: labelText });

  var placeholder = el.getAttribute("placeholder");
  if (placeholder) out.push({ strategy: "placeholder", value: placeholder });

  if (!isFormField) {
    var text = __qaTextContent(el);
    if (text && text.length <= 80) out.push({ strategy: "text", value: text });
  }

  // Scoped variants: the same semantic locators inside the nearest row, list
  // item or test-id container. They rescue nameless controls (a bare
  // getByRole('radio') inside its row) and disambiguate repeated ones (one
  // quantity field per row). Placed after the unscoped candidates so a unique
  // unscoped locator still wins, before id/css so structure stays last.
  var semantic = out.filter(function (c) {
    return c.strategy === "role" || c.strategy === "label" || c.strategy === "placeholder" || c.strategy === "text";
  });
  var scope = __qaScope(el);
  // The extraction's own scope (a dialog, a form) is a container too: a
  // locator unique inside it is what a test scoped to that region uses.
  // Skip when the row/list/test-id container already sits inside the scope
  // root... no: both are emitted, the nearer container first.
  var scopes: RawScope[] = [];
  if (scope) scopes.push(scope);
  if (rootScope && (!scope || scope.kind !== "test-id")) scopes.push(rootScope);
  for (var sci = 0; sci < scopes.length; sci++) {
    var container = scopes[sci]!;
    if (semantic.length === 0 && role && authorNamedOnly.indexOf(role) < 0) {
      // Nameless control: bare role inside the container.
      out.push({ strategy: "role", value: "", role: role, within: container });
    }
    for (var si = 0; si < semantic.length; si++) {
      var sc = semantic[si]!;
      var scoped: RawLocatorCandidate = { strategy: sc.strategy, value: sc.value, within: container };
      if (sc.role !== undefined) scoped.role = sc.role;
      out.push(scoped);
    }
  }

  if (el.id) {
    if (__qaIsGeneratedId(el.id)) {
      out.push({ strategy: "id", value: el.id, last_resort: true });
      noteParts.push(
        "Element id '" + el.id + "' looks framework-generated and may change between builds; demoted to last resort.",
      );
    } else {
      out.push({ strategy: "id", value: el.id });
    }
  }

  if (!inShadow && cssPath) out.push({ strategy: "css", value: cssPath, last_resort: true });

  return { candidates: out, note: noteParts.length > 0 ? noteParts.join(" ") : null };
}

/**
 * Nearest container a locator can be scoped to, in preference order: a
 * test-id ancestor (stable), a table row (Playwright names rows from their
 * content), a list item (filtered by its text). The row/item text is the
 * first short cell or child text, since name matching is a substring match.
 */
export function __qaScope(el: Element): RawScope | null {
  var cur: Element | null = el.parentElement;
  while (cur && cur !== document.body) {
    var tid = cur.getAttribute("data-testid");
    if (tid) return { kind: "test-id", value: tid };
    var tag = cur.tagName.toLowerCase();
    var role = cur.getAttribute("role");
    if (tag === "tr" || role === "row") {
      var rowText = __qaScopeText(cur, "td,th,[role=cell],[role=gridcell],[role=rowheader],[role=columnheader]");
      if (rowText) return { kind: "row", value: rowText };
    }
    if (tag === "li" || role === "listitem") {
      var itemText = __qaScopeText(cur, "*");
      if (itemText) return { kind: "listitem", value: itemText };
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Text that identifies this container among its siblings: the first short
 * part (a cell, a child) whose text no sibling container shares. A status
 * badge or a date repeated on every row is skipped; the product name or SKU
 * is chosen. Falls back to the first short part, then to the own text.
 */
export function __qaScopeText(container: Element, partSelector: string): string | null {
  var siblings: Element[] = [];
  var parent = container.parentElement;
  if (parent) {
    var kids = parent.children;
    for (var k = 0; k < kids.length; k++) if (kids[k] !== container) siblings.push(kids[k]!);
  }
  var parts = container.querySelectorAll(partSelector);
  var firstShort: string | null = null;
  for (var i = 0; i < parts.length; i++) {
    var t = __qaCollapse(parts[i]!.textContent);
    if (!t || t.length < 2 || t.length > 60) continue;
    if (firstShort === null) firstShort = t;
    var shared = false;
    for (var s = 0; s < siblings.length; s++) {
      if (__qaCollapse(siblings[s]!.textContent).indexOf(t) >= 0) {
        shared = true;
        break;
      }
    }
    if (!shared) return t;
  }
  if (firstShort !== null) return firstShort;
  var own = __qaCollapse(container.textContent);
  if (!own) return null;
  return own.length > 40 ? own.slice(0, 40) : own;
}

/**
 * The element a `scope` selector means: the LAST visible match, else the
 * first match. Dialog libraries keep a closed dialog in the DOM and stack an
 * open one on top of another, appended later; "[role=dialog]" must resolve
 * to the one the user is looking at. For anything else, pass a selector the
 * outline reported as unique.
 */
export function __qaScopeRoot(selector: string): Element | null {
  var all = document.querySelectorAll(selector);
  var lastVisible: Element | null = null;
  for (var i = 0; i < all.length; i++) {
    var el = all[i]!;
    if (__qaVisibility(el, __qaAncestorFlags(el)).visible) lastVisible = el;
  }
  return lastVisible || (all.length > 0 ? all[0]! : null);
}

/** Display-none state of an element's ancestors, for a traversal that starts below the root. */
export function __qaAncestorFlags(el: Element): AncestorFlags {
  var cur = el.parentElement;
  while (cur) {
    if (window.getComputedStyle(cur).display === "none") return { displayNone: true };
    cur = cur.parentElement;
  }
  return { displayNone: false };
}

/**
 * For a form control with no accessible name: the nearest text before it in
 * its form-item container, as a HINT only. Component libraries render the
 * visible label without associating it, so this is not a locator source.
 */
export function __qaNearbyLabelHint(el: Element): string | null {
  var cur: Element | null = el;
  for (var hops = 0; cur && hops < 4; hops++) {
    var prev = cur.previousElementSibling;
    while (prev) {
      var t = __qaCollapse(prev.textContent);
      if (t && t.length <= 60) return t;
      prev = prev.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return null;
}

export function __qaScopeHint(el: Element): string | null {
  var cur: Element | null = el.parentElement;
  while (cur) {
    var tid = cur.getAttribute("data-testid");
    if (tid) return tid;
    cur = cur.parentElement;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Node builder                                                         */
/* ------------------------------------------------------------------ */

export function __qaBuildNode(el: Element, inShadow: boolean, visible: boolean, clickTarget?: boolean, rootScope?: RawScope | null): RawNode {
  var role = __qaRole(el);
  var accessibleName = __qaAccessibleName(el);
  var cssPath = inShadow ? "" : __qaCssPath(el);
  // The heading names a click-target card (the full text blob stays in
  // text_content); it must be settled before candidates are derived so a
  // role candidate never carries the blob.
  var heading = clickTarget ? __qaClickTargetHeading(el) : null;
  if (heading) accessibleName = heading;
  var cand = __qaCandidates(el, role, accessibleName, inShadow, cssPath, rootScope);
  if (clickTarget) {
    if (heading) cand.candidates.unshift({ strategy: "text", value: heading });
    cand.note =
      (cand.note ? cand.note + " " : "") +
      "Opt-in click-target heuristic (cursor:pointer, no role/test-id); consider adding a role or data-testid.";
  }
  var node: RawNode = {
    kind: "element",
    tag: el.tagName.toLowerCase(),
    role: role,
    in_shadow: inShadow,
    form_group: __qaFormGroup(el),
    accessible_name: accessibleName,
    candidates: cand.candidates,
    scope_hint: __qaScopeHint(el),
    identity: __qaIdentity(el, role, accessibleName),
    css_path: cssPath,
    properties: __qaProperties(el, visible),
  };
  if (cand.note) node.context_note = cand.note;
  // Unlabeled form control (a framework combobox whose visible label is not
  // associated): say what text sits before it, flagged as a hint.
  var tagLower = el.tagName.toLowerCase();
  if (!accessibleName && (tagLower === "input" || tagLower === "select" || tagLower === "textarea" || role === "combobox")) {
    var hint = __qaNearbyLabelHint(el);
    if (hint) {
      node.context_note =
        (node.context_note ? node.context_note + " " : "") +
        "Unlabeled control; nearest text before it is '" + hint + "' (hint only, not an association; ask the frontend for a label or aria-label).";
    }
  }
  // Notification libraries (Ant Design and friends) often keep the
  // role=alert/status live region EMPTY and render the message in a sibling.
  // Pull the text from the nearest non-empty enclosing container so tests
  // can assert the message, and say where it came from.
  if ((role === "alert" || role === "status") && !node.properties.text_content) {
    var anc = el.parentElement;
    var hops = 0;
    while (anc && anc !== document.body && hops < 3) {
      var ancText = __qaCollapse(anc.textContent);
      if (ancText) {
        node.properties.text_content = ancText.length > 120 ? ancText.slice(0, 120) : ancText;
        node.context_note =
          (node.context_note ? node.context_note + " " : "") +
          "Live region element is empty; text_content was taken from its enclosing container (" +
          (hops + 1) +
          " level(s) up); assert the text on that container (e.g. locator('..') from this node), not on the empty live region.";
        break;
      }
      anc = anc.parentElement;
      hops++;
    }
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* Main traversal — iterative, forest of roots                          */
/* ------------------------------------------------------------------ */

export function __qaExtract(opts: InPageOptions): RawExtractResult {
  var nodes: RawNode[] = [];
  var notes: string[] = [];
  var truncated = false;
  var depthNoteAdded = false;

  var closedHosts = (window as unknown as { __qaMcpClosedShadowHosts?: WeakSet<Element> })
    .__qaMcpClosedShadowHosts;

  // Tags whose internals are never test-relevant. iframe/frame are
  // handled at the Playwright layer via per-frame evaluation, never in-page.
  var SKIP: { [tag: string]: boolean } = {
    script: true, style: true, svg: true, template: true,
    noscript: true, head: true, iframe: true, frame: true,
  };

  interface StackEntry { el: Element; depth: number; inShadow: boolean; anc: AncestorFlags; ptr: boolean }
  var root: Element = document.documentElement;
  if (opts.scopeSelector) {
    var scoped: Element | null = null;
    try {
      scoped = __qaScopeRoot(opts.scopeSelector);
    } catch (e) {
      notes.push("scope '" + opts.scopeSelector + "' is not a valid CSS selector; nothing extracted.");
      return { nodes: [], truncated: false, notes: notes };
    }
    if (!scoped) {
      notes.push("scope '" + opts.scopeSelector + "' matched no element; nothing extracted.");
      return { nodes: [], truncated: false, notes: notes };
    }
    root = scoped;
  }
  var rootAnc: AncestorFlags = root === document.documentElement ? { displayNone: false } : __qaAncestorFlags(root);
  var rootScope: RawScope | null = opts.scopeSelector && root !== document.documentElement ? { kind: "css", value: opts.scopeSelector } : null;
  var roleFilter: { [key: string]: boolean } | null = null;
  if (opts.roles && opts.roles.length > 0) {
    roleFilter = {};
    for (var rf = 0; rf < opts.roles.length; rf++) roleFilter[opts.roles[rf]!.toLowerCase()] = true;
  }
  var stack: StackEntry[] = [{ el: root, depth: 0, inShadow: false, anc: rootAnc, ptr: false }];

  while (stack.length > 0) {
    var entry = stack.pop()!;
    var el = entry.el;
    var tag = el.tagName.toLowerCase();
    if (SKIP[tag]) continue;

    if (entry.depth > opts.maxDepth) {
      truncated = true;
      if (!depthNoteAdded) {
        depthNoteAdded = true;
        notes.push("MAX_DEPTH (" + opts.maxDepth + ") hit; deeper nodes were not traversed.");
      }
      continue;
    }

    var vis = __qaVisibility(el, entry.anc);

    // Closed shadow root: unreachable — emit one boundary marker.
    // Detection relies on pre-navigation attachShadow instrumentation; roots
    // created via declarative shadow DOM before scripts run are undetectable.
    if (closedHosts && closedHosts.has(el)) {
      var marker = __qaBuildNode(el, entry.inShadow, vis.visible);
      marker.kind = "shadow_boundary";
      marker.context_note =
        "Closed shadow root: contents are unreachable and were not extracted. Light-DOM children were skipped (rendering unknown).";
      if (nodes.length >= opts.maxNodes) {
        truncated = true;
        notes.push("MAX_NODES (" + opts.maxNodes + ") hit; traversal stopped early.");
        break;
      }
      nodes.push(marker);
      continue;
    }

    var role = __qaRole(el);
    var included = __qaShouldInclude(el, role);
    // Opt-in click-target heuristic (spec amendment, v0.4): a cursor:pointer
    // BOUNDARY (parent chain not pointer) with content is very likely a
    // JS-click card that carries no anchor/role/test-id. Boundary detection
    // matters because cursor is inherited by every descendant.
    var clickTarget =
      !included && !!opts.includeClickTargets && vis.pointer && !entry.ptr && __qaHasContent(el);
    if (included || clickTarget) {
      var keep = true;
      if (roleFilter && !roleFilter[(role || "").toLowerCase()] && !roleFilter[tag]) keep = false;
      if (keep && opts.visibleOnly && !vis.visible) keep = false;
      if (keep) {
        if (nodes.length >= opts.maxNodes) {
          truncated = true;
          notes.push("MAX_NODES (" + opts.maxNodes + ") hit; traversal stopped early.");
          break;
        }
        nodes.push(__qaBuildNode(el, entry.inShadow, vis.visible, clickTarget, rootScope));
      }
    }

    // Descend: open shadow root first (flagged in_shadow), then light children.
    var i: number;
    var childPtr = entry.ptr || vis.pointer;
    if (el.shadowRoot) {
      var sc = el.shadowRoot.children;
      for (i = sc.length - 1; i >= 0; i--) {
        stack.push({ el: sc[i]!, depth: entry.depth + 1, inShadow: true, anc: vis.self, ptr: childPtr });
      }
    }
    var kids = el.children;
    for (i = kids.length - 1; i >= 0; i--) {
      stack.push({ el: kids[i]!, depth: entry.depth + 1, inShadow: entry.inShadow, anc: vis.self, ptr: childPtr });
    }
  }

  return { nodes: nodes, truncated: truncated, notes: notes };
}

/* ------------------------------------------------------------------ */
/* Outline engine (v0.8): the page as a map                              */
/* ------------------------------------------------------------------ */

export interface RawRegion {
  kind: string;
  name: string | null;
  /** CSS selector that `scope` accepts; short when the page allows it. */
  selector: string;
  interactive_count: number;
  is_visible: boolean;
  row_count?: number;
  item_count?: number;
}

export interface RawTable {
  selector: string;
  name: string | null;
  headers: string[];
  row_count: number;
  rows: Array<{ identity: string | null; cells: { [header: string]: string } }>;
  truncated: boolean;
}

export interface RawDialog {
  selector: string;
  name: string | null;
  is_visible: boolean;
  text: string;
  fields: { [label: string]: string };
}

export interface RawOutline {
  regions: RawRegion[];
  tables: RawTable[];
  dialogs: RawDialog[];
  alerts: string[];
  interactive_count: number;
  notes: string[];
}

export interface OutlineOptions {
  maxRows: number;
  /** Restrict to this selector (structured data for one region). */
  scopeSelector?: string;
}

/** Shortest selector that identifies the element on this page, for `scope`. */
export function __qaRegionSelector(el: Element): string {
  var tid = el.getAttribute("data-testid");
  if (tid) return '[data-testid="' + tid.replace(/"/g, '\\"') + '"]';
  if (el.id && !__qaIsGeneratedId(el.id) && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
  var tag = el.tagName.toLowerCase();
  var role = el.getAttribute("role");
  var candidates = [tag, role ? '[role="' + role + '"]' : null, role ? tag + '[role="' + role + '"]' : null];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c && document.querySelectorAll(c).length === 1) return c;
  }
  var label = el.getAttribute("aria-label");
  if (label) {
    var sel = tag + '[aria-label="' + label.replace(/"/g, '\\"') + '"]';
    if (document.querySelectorAll(sel).length === 1) return sel;
  }
  // Landmark-prefixed ("main table", "header nav"), then a short structural path.
  var landmark = el.parentElement ? el.parentElement.closest("main, header, footer, nav, aside, form, dialog, [role=dialog], section") : null;
  if (landmark) {
    var lsel = __qaRegionSelectorShort(landmark) + " " + tag;
    if (document.querySelectorAll(lsel).length === 1) return lsel;
  }
  var short = __qaRegionSelectorShort(el);
  if (document.querySelectorAll(short).length === 1) return short;
  // Last resort: a chain that starts at the nearest ancestor with a usable id or test-id.
  var anchor: Element | null = el.parentElement;
  while (anchor && anchor !== document.documentElement) {
    var atid = anchor.getAttribute("data-testid");
    var aid = anchor.id && !__qaIsGeneratedId(anchor.id) ? anchor.id : "";
    if (atid || aid) {
      var prefix = atid ? '[data-testid="' + atid.replace(/"/g, '\\"') + '"]' : "#" + CSS.escape(aid);
      var rel = __qaRegionSelectorShort(el);
      var combined = prefix + " " + rel;
      if (document.querySelectorAll(combined).length === 1) return combined;
      break;
    }
    anchor = anchor.parentElement;
  }
  return __qaCssPath(el) || tag;
}

/** `parent > tag:nth-of-type(k)` chain up to 3 levels, as short as uniqueness allows. */
export function __qaRegionSelectorShort(el: Element): string {
  var parts: string[] = [];
  var cur: Element | null = el;
  for (var depth = 0; cur && cur !== document.documentElement && depth < 6; depth++) {
    var t = cur.tagName.toLowerCase();
    var seg = t;
    if (cur.id && !__qaIsGeneratedId(cur.id)) {
      parts.unshift("#" + CSS.escape(cur.id));
      break;
    }
    var parent: Element | null = cur.parentElement;
    if (parent) {
      var same = 0;
      var idx = 0;
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i]!.tagName === cur.tagName) {
          same++;
          if (parent.children[i] === cur) idx = same;
        }
      }
      if (same > 1) seg = t + ":nth-of-type(" + idx + ")";
    }
    parts.unshift(seg);
    if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
    cur = parent;
  }
  return parts.join(" > ");
}

export function __qaCountInteractive(root: Element): number {
  var n = 0;
  var all = root.querySelectorAll("*");
  for (var i = 0; i < all.length; i++) {
    var el = all[i]!;
    if (__qaShouldInclude(el, __qaRole(el))) n++;
  }
  return n;
}

export function __qaRegionName(el: Element): string | null {
  var label = __qaCollapse(el.getAttribute("aria-label"));
  if (label) return label;
  var labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    var ref = document.getElementById(labelledBy.split(/\s+/)[0]!);
    var t = ref ? __qaCollapse(ref.textContent) : "";
    if (t) return t;
  }
  var heading = el.querySelector("h1,h2,h3,h4,caption,legend");
  if (heading) {
    var h = __qaCollapse(heading.textContent);
    if (h) return h.length > 80 ? h.slice(0, 80) : h;
  }
  return null;
}

export function __qaCellText(cell: Element): string {
  var it = (cell as HTMLElement).innerText;
  var t = __qaCollapse(typeof it === "string" && it ? it : cell.textContent);
  if (!t) {
    var input = cell.querySelector("input,select,textarea");
    if (input) t = __qaCollapse((input as HTMLInputElement).value);
  }
  return t.length > 80 ? t.slice(0, 80) : t;
}

/**
 * Component libraries with a fixed header render TWO tables: one holding only
 * the <thead>, the next holding only the <tbody>. The body table borrows the
 * headers of the nearest preceding header-only table in the same container.
 */
export function __qaHeaderDonor(table: Element): Element | null {
  var container: Element | null = table.parentElement;
  for (var up = 0; container && up < 4; up++) {
    var tables = container.querySelectorAll("table");
    var previous: Element | null = null;
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i]!;
      if (t === table) break;
      if (t.querySelector("thead th, thead td") && !t.querySelector("tbody tr")) previous = t;
    }
    if (previous) return previous;
    container = container.parentElement;
  }
  return null;
}

export function __qaTableData(table: Element, maxRows: number): RawTable {
  var headers: string[] = [];
  var headerCells = table.querySelectorAll("thead th, thead td, tr:first-child th, [role=columnheader]");
  if (headerCells.length === 0) {
    var donor = __qaHeaderDonor(table);
    if (donor) headerCells = donor.querySelectorAll("thead th, thead td");
  }
  for (var h = 0; h < headerCells.length; h++) {
    var ht = __qaCellText(headerCells[h]!);
    headers.push(ht || "col" + (h + 1));
  }
  var rowEls: Element[] = [];
  var trs = table.querySelectorAll("tbody tr, [role=row]");
  for (var r = 0; r < trs.length; r++) {
    var tr = trs[r]!;
    if (tr.querySelector("th") && !tr.querySelector("td") && headers.length > 0) continue; // header row
    if (tr.closest("thead")) continue;
    rowEls.push(tr);
  }
  var rows: RawTable["rows"] = [];
  for (var i = 0; i < rowEls.length && i < maxRows; i++) {
    var cells = rowEls[i]!.querySelectorAll("td, th, [role=cell], [role=gridcell], [role=rowheader]");
    var record: { [header: string]: string } = {};
    var nonEmpty = 0;
    for (var c = 0; c < cells.length; c++) {
      var key = headers[c] || "col" + (c + 1);
      record[key] = __qaCellText(cells[c]!);
      if (record[key]) nonEmpty++;
    }
    if (nonEmpty === 0) continue; // layout/measure rows carry no data
    rows.push({ identity: __qaScopeText(rowEls[i]!, "td,th,[role=cell],[role=gridcell],[role=rowheader]"), cells: record });
  }
  return {
    selector: __qaRegionSelector(table),
    name: __qaRegionName(table),
    headers: headers,
    row_count: rowEls.length,
    rows: rows,
    truncated: rowEls.length > maxRows,
  };
}

/** Label/value pairs from a dialog or detail panel: <dl>, "Label: value" lines, two-cell rows. */
export function __qaFields(root: Element): { [label: string]: string } {
  var out: { [label: string]: string } = {};
  var dts = root.querySelectorAll("dt");
  for (var i = 0; i < dts.length; i++) {
    var dt = dts[i]!;
    var dd = dt.nextElementSibling;
    if (dd && dd.tagName.toLowerCase() === "dd") {
      var k = __qaCollapse(dt.textContent);
      if (k) out[k] = __qaCellText(dd);
    }
  }
  // Two-part rows: an element with exactly two children whose first is short
  // label-like text. Table cells are reported as tables, not as fields.
  var blocks = root.querySelectorAll("div, li, p");
  for (var b = 0; b < blocks.length; b++) {
    var block = blocks[b]!;
    if (block.children.length !== 2) continue;
    if (block.closest("table")) continue;
    var first = block.children[0]!;
    var second = block.children[1]!;
    // A label is short, plain text: not a heading, not a control, not a block of controls.
    if (/^(H[1-6]|BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(first.tagName) || first.querySelector("button, a, input, select, h1, h2, h3, h4")) continue;
    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(second.tagName) || second.querySelector("button, a, input, select")) continue;
    var a = __qaCollapse(first.textContent);
    var v = __qaCollapse(second.textContent);
    if (!a || !v || a.length > 30 || v.length > 120) continue;
    var key2 = a.replace(/:$/, "");
    if (out[key2] === undefined) out[key2] = v;
  }
  return out;
}

export function __qaDialogData(el: Element): RawDialog {
  var vis = __qaVisibility(el, __qaAncestorFlags(el));
  var text = __qaCollapse(el.textContent);
  return {
    selector: __qaRegionSelector(el),
    name: __qaRegionName(el),
    is_visible: vis.visible,
    text: text.length > 400 ? text.slice(0, 400) : text,
    fields: __qaFields(el),
  };
}

/**
 * Descendants of the root matching `sel`, plus the root itself when it
 * matches: an outline scoped to a dialog or a table must describe that
 * element. Top-level on purpose: nested function declarations get wrapped by
 * bundler helpers that do not exist inside the page.
 */
export function __qaCollect(root: Element | Document, sel: string): Element[] {
  var found: Element[] = [];
  if (root !== document && (root as Element).matches(sel)) found.push(root as Element);
  var q = root.querySelectorAll(sel);
  for (var qi = 0; qi < q.length; qi++) found.push(q[qi]!);
  return found;
}

/**
 * Signature of an element's "shape": tag plus its first class token. Cards in
 * a grid share it; unrelated siblings do not. Used to find repeated-structure
 * containers (product grids, card lists) that carry no list/table semantics.
 */
export function __qaShapeSignature(el: Element): string {
  var cls = (el.getAttribute("class") || "").trim().split(/\s+/)[0] || "";
  return el.tagName.toLowerCase() + "." + cls;
}

/**
 * Containers whose children repeat the same shape at least `min` times and
 * carry interactive content: an SPA product grid, a card list, a result list.
 * Most listings are <div> grids, so landmark selectors alone miss them, and
 * they are exactly what an agent wants to scope an extraction to.
 */
export function __qaRepeatedContainers(root: Element | Document, min: number): Array<{ el: Element; count: number }> {
  var out: Array<{ el: Element; count: number }> = [];
  var candidates = __qaCollect(root, "div, section, ul, ol, main");
  for (var i = 0; i < candidates.length && out.length < 8; i++) {
    var el = candidates[i]!;
    var kids = el.children;
    if (kids.length < min) continue;
    var counts: { [sig: string]: number } = {};
    var best = 0;
    for (var k = 0; k < kids.length; k++) {
      var sig = __qaShapeSignature(kids[k]!);
      var next = (counts[sig] || 0) + 1;
      counts[sig] = next;
      if (next > best) best = next;
    }
    // The repeated shape must dominate the container and carry content.
    if (best < min || best < kids.length / 2) continue;
    if (__qaCountInteractive(el) === 0 && !__qaCollapse(el.textContent)) continue;
    // Keep the innermost container: skip when an already-found one is inside this.
    var containsFound = false;
    for (var f = 0; f < out.length; f++) if (el.contains(out[f]!.el)) containsFound = true;
    if (containsFound) continue;
    out.push({ el: el, count: best });
  }
  return out;
}

export function __qaOutline(opts: OutlineOptions): RawOutline {
  var notes: string[] = [];
  var root: Element | Document = document;
  if (opts.scopeSelector) {
    var scoped: Element | null = null;
    try {
      scoped = __qaScopeRoot(opts.scopeSelector);
    } catch (e) {
      notes.push("scope '" + opts.scopeSelector + "' is not a valid CSS selector.");
    }
    if (!scoped) {
      if (notes.length === 0) notes.push("scope '" + opts.scopeSelector + "' matched no element.");
      return { regions: [], tables: [], dialogs: [], alerts: [], interactive_count: 0, notes: notes };
    }
    root = scoped;
  }

  var regions: RawRegion[] = [];
  var landmarkSel =
    "header, nav, main, aside, footer, form, section[aria-label], section[aria-labelledby], " +
    '[role="banner"], [role="navigation"], [role="main"], [role="complementary"], [role="contentinfo"], ' +
    '[role="region"], [role="search"], [role="form"], [role="tablist"], [role="menu"], [role="toolbar"], ' +
    'table, [role="table"], [role="grid"], ul, ol, [role="list"], dialog, [role="dialog"], [role="alertdialog"]';
  var els = __qaCollect(root, landmarkSel);
  var seen: Element[] = [];
  for (var i = 0; i < els.length; i++) {
    var el = els[i]!;
    // Nested landmarks of the same kind (a list inside a list) add noise: keep the outermost.
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role") || "";
    // Kinds are ARIA landmark names so an agent reads one vocabulary.
    var tagKinds: { [t: string]: string } = { nav: "navigation", header: "banner", footer: "contentinfo", aside: "complementary", main: "main", form: "form", section: "region" };
    var kind =
      tag === "table" || role === "table" || role === "grid"
        ? "table"
        : tag === "ul" || tag === "ol" || role === "list"
          ? "list"
          : tag === "dialog" || role === "dialog" || role === "alertdialog"
            ? "dialog"
            : role || tagKinds[tag] || tag;
    var count = __qaCountInteractive(el);
    if (kind === "list") {
      var items = el.querySelectorAll(":scope > li, :scope > [role=listitem]").length;
      if (items < 2 || count === 0) continue; // decorative or nav sub-lists carry nothing to extract
      var outerList = el.parentElement ? el.parentElement.closest("ul, ol, [role=list]") : null;
      if (outerList && root !== el) continue;
    }
    if (count === 0 && kind !== "dialog" && kind !== "table") continue;
    var vis = __qaVisibility(el, __qaAncestorFlags(el));
    var region: RawRegion = {
      kind: kind,
      name: __qaRegionName(el),
      selector: __qaRegionSelector(el),
      interactive_count: count,
      is_visible: vis.visible,
    };
    if (kind === "table") region.row_count = el.querySelectorAll("tbody tr, [role=row]").length;
    if (kind === "list") region.item_count = el.querySelectorAll(":scope > li, :scope > [role=listitem]").length;
    regions.push(region);
    seen.push(el);
  }

  // Repeated-structure containers (card grids): a listing an agent can scope to.
  var repeated = __qaRepeatedContainers(root, 3);
  for (var rp = 0; rp < repeated.length; rp++) {
    var rEl = repeated[rp]!.el;
    var alreadyListed = false;
    for (var se = 0; se < seen.length; se++) if (seen[se] === rEl) alreadyListed = true;
    if (alreadyListed) continue;
    var rCount = __qaCountInteractive(rEl);
    if (rCount === 0) continue;
    var rVis = __qaVisibility(rEl, __qaAncestorFlags(rEl));
    regions.push({
      kind: "list",
      name: __qaRegionName(rEl),
      selector: __qaRegionSelector(rEl),
      interactive_count: rCount,
      is_visible: rVis.visible,
      item_count: repeated[rp]!.count,
    });
    seen.push(rEl);
  }

  var tables: RawTable[] = [];
  var tableEls = __qaCollect(root, "table, [role=table], [role=grid]");
  for (var t = 0; t < tableEls.length && t < 10; t++) {
    var te = tableEls[t]!;
    // A header-only table whose headers a following body table borrows is half of one table.
    if (te.querySelector("thead th, thead td") && !te.querySelector("tbody tr")) {
      var borrowed = false;
      for (var t2 = t + 1; t2 < tableEls.length; t2++) if (__qaHeaderDonor(tableEls[t2]!) === te) borrowed = true;
      if (borrowed) continue;
    }
    tables.push(__qaTableData(te, opts.maxRows));
  }

  var dialogs: RawDialog[] = [];
  var dialogEls = __qaCollect(root, "dialog[open], [role=dialog], [role=alertdialog]");
  for (var d = 0; d < dialogEls.length && d < 5; d++) dialogs.push(__qaDialogData(dialogEls[d]!));

  var alerts: string[] = [];
  var alertEls = __qaCollect(root, "[role=alert], [role=status]");
  for (var a = 0; a < alertEls.length && a < 10; a++) {
    var at = __qaCollapse(alertEls[a]!.textContent) || __qaCollapse(alertEls[a]!.parentElement ? alertEls[a]!.parentElement!.textContent : "");
    if (at) alerts.push(at.length > 160 ? at.slice(0, 160) : at);
  }

  var total = __qaCountInteractive(root === document ? document.documentElement : (root as Element));
  return { regions: regions, tables: tables, dialogs: dialogs, alerts: alerts, interactive_count: total, notes: notes };
}
