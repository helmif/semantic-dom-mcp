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
export interface RawLocatorCandidate {
  strategy: "test-id" | "role" | "label" | "placeholder" | "text" | "id" | "css";
  value: string;
  /** Only for strategy "role". */
  role?: string;
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
}

/** Inherited ancestor visibility flags carried down the traversal stack. */
interface AncestorFlags {
  displayNone: boolean;
  opacityZero: boolean;
  hiddenAttr: boolean;
  ariaHidden: boolean;
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
/* (precedence: aria-label > aria-labelledby > <label> > text)          */
/* ------------------------------------------------------------------ */

export function __qaLabelText(el: Element): string | null {
  // aria-labelledby references
  var labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    var root = el.getRootNode() as Document | ShadowRoot;
    var parts: string[] = [];
    var ids = labelledBy.split(/\s+/);
    for (var i = 0; i < ids.length; i++) {
      if (!ids[i]) continue;
      var ref = root.getElementById ? root.getElementById(ids[i]!) : null;
      if (ref) parts.push(__qaCollapse(ref.textContent));
    }
    var joined = __qaCollapse(parts.join(" "));
    if (joined) return joined;
  }
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
    tag === "input" || tag === "button" || tag === "a" || tag === "select" || tag === "textarea" || tag === "label";
  if (nativeInteractive) return true;
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
  var ti = el.getAttribute("tabindex");
  if (ti !== null) {
    var n = parseInt(ti, 10);
    if (!isNaN(n) && n >= 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Properties & visibility                                              */
/* ------------------------------------------------------------------ */

export function __qaVisibility(el: Element, anc: AncestorFlags): {
  visible: boolean;
  self: AncestorFlags;
  pointer: boolean;
} {
  var cs = window.getComputedStyle(el);
  var self: AncestorFlags = {
    displayNone: anc.displayNone || cs.display === "none",
    opacityZero: anc.opacityZero || parseFloat(cs.opacity) === 0,
    hiddenAttr: anc.hiddenAttr || el.hasAttribute("hidden"),
    ariaHidden: anc.ariaHidden || el.getAttribute("aria-hidden") === "true",
  };
  var hidden = self.displayNone || self.opacityZero || self.hiddenAttr || self.ariaHidden;
  if (!hidden && (cs.visibility === "hidden" || cs.visibility === "collapse")) hidden = true;
  if (!hidden) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) hidden = true;
  }
  if (!hidden && el instanceof HTMLElement && el.offsetParent === null && cs.position !== "fixed") {
    // <body>/<html> legitimately have no offsetParent
    var t = el.tagName.toLowerCase();
    if (t !== "body" && t !== "html") hidden = true;
  }
  return { visible: !hidden, self: self, pointer: cs.cursor === "pointer" };
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

/** Click targets must carry content — empty pointer divs are decoration. */
export function __qaHasContent(el: Element): boolean {
  if (__qaCollapse(el.textContent)) return true;
  return !!(el.querySelector && el.querySelector("img"));
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

  return {
    type: type,
    placeholder: placeholder,
    text_content: text,
    href: href,
    is_required: required,
    is_disabled: disabled,
    is_checked: checked,
    is_visible: visible,
  };
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

  var labelText = __qaLabelText(el);
  if (labelText) out.push({ strategy: "label", value: labelText });

  var placeholder = el.getAttribute("placeholder");
  if (placeholder) out.push({ strategy: "placeholder", value: placeholder });

  if (!isFormField) {
    var text = __qaTextContent(el);
    if (text && text.length <= 80) out.push({ strategy: "text", value: text });
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

export function __qaBuildNode(el: Element, inShadow: boolean, visible: boolean, clickTarget?: boolean): RawNode {
  var role = __qaRole(el);
  var accessibleName = __qaAccessibleName(el);
  var cssPath = inShadow ? "" : __qaCssPath(el);
  var cand = __qaCandidates(el, role, accessibleName, inShadow, cssPath);
  if (clickTarget) {
    var heading = __qaClickTargetHeading(el);
    if (heading) cand.candidates.unshift({ strategy: "text", value: heading });
    cand.note =
      (cand.note ? cand.note + " " : "") +
      "Included via the opt-in cursor:pointer click-target heuristic; the element has no native interactive semantics (consider adding a role or data-testid).";
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
    css_path: cssPath,
    properties: __qaProperties(el, visible),
  };
  if (cand.note) node.context_note = cand.note;
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
          "Live region element is empty; text_content was taken from its enclosing container.";
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
  var rootAnc: AncestorFlags = { displayNone: false, opacityZero: false, hiddenAttr: false, ariaHidden: false };
  var stack: StackEntry[] = [{ el: document.documentElement, depth: 0, inShadow: false, anc: rootAnc, ptr: false }];

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
      if (nodes.length >= opts.maxNodes) {
        truncated = true;
        notes.push("MAX_NODES (" + opts.maxNodes + ") hit; traversal stopped early.");
        break;
      }
      nodes.push(__qaBuildNode(el, entry.inShadow, vis.visible, clickTarget));
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
