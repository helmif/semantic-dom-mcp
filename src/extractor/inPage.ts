/**
 * Assembles the self-contained in-page extractor script.
 *
 * `page.evaluate` runs code inside the browser page where no imports exist,
 * so the traversal functions from traverse.ts are stringified and
 * concatenated into a single function expression. Function declarations are
 * hoisted within that scope, so they can call each other by name.
 */
import type { InPageOptions } from "./traverse.js";
import {
  __qaCellText,
  __qaCollect,
  __qaCountInteractive,
  __qaDialogData,
  __qaFields,
  __qaHeaderDonor,
  __qaOutline,
  __qaRegionName,
  __qaRegionSelector,
  __qaRegionSelectorShort,
  __qaRepeatedContainers,
  __qaShapeSignature,
  __qaTableData,
  type OutlineOptions,
} from "./traverse.js";
import {
  __qaAccessibleName,
  __qaAncestorFlags,
  __qaAriaBool,
  __qaBuildNode,
  __qaCandidates,
  __qaClickTargetHeading,
  __qaCollapse,
  __qaCssPath,
  __qaHasBox,
  __qaHasContent,
  __qaExtract,
  __qaIdentity,
  __qaIdRefsText,
  __qaFormGroup,
  __qaIsGeneratedId,
  __qaLabelText,
  __qaNearbyLabelHint,
  __qaProperties,
  __qaRole,
  __qaScope,
  __qaScopeHint,
  __qaScopeRoot,
  __qaScopeText,
  __qaShouldInclude,
  __qaTestAttr,
  __qaTextContent,
  __qaVisibility,
} from "./traverse.js";

const IN_PAGE_FUNCTIONS: ReadonlyArray<(...args: never[]) => unknown> = [
  __qaCollapse,
  __qaAriaBool,
  __qaAncestorFlags,
  __qaNearbyLabelHint,
  __qaIdRefsText,
  __qaHasBox,
  __qaTextContent,
  __qaIsGeneratedId,
  __qaClickTargetHeading,
  __qaHasContent,
  __qaRole,
  __qaLabelText,
  __qaAccessibleName,
  __qaFormGroup,
  __qaCssPath,
  __qaTestAttr,
  __qaIdentity,
  __qaShouldInclude,
  __qaVisibility,
  __qaProperties,
  __qaScopeText,
  __qaScopeRoot,
  __qaScope,
  __qaCandidates,
  __qaScopeHint,
  __qaBuildNode,
  __qaExtract,
  // outline engine
  __qaRegionSelector,
  __qaRegionSelectorShort,
  __qaShapeSignature,
  __qaRepeatedContainers,
  __qaCollect,
  __qaCountInteractive,
  __qaRegionName,
  __qaCellText,
  __qaHeaderDonor,
  __qaTableData,
  __qaFields,
  __qaDialogData,
  __qaOutline,
];

/** Strips a leading `export ` in case the runtime includes it in source text. */
function fnSource(fn: (...args: never[]) => unknown): string {
  return fn.toString().replace(/^export\s+/, "");
}

let cachedScript: string | undefined;

/**
 * Returns a function-expression string: `(opts) => RawExtractResult`.
 * Evaluate with: frame.evaluate(`(${script})(${JSON.stringify(opts)})`).
 */
export function buildInPageScript(): string {
  if (!cachedScript) {
    const body = IN_PAGE_FUNCTIONS.map(fnSource).join("\n");
    cachedScript = `(function (opts) {\n${body}\nreturn __qaExtract(opts);\n})`;
  }
  return cachedScript;
}

/** Builds the full evaluate expression for a given options object. */
export function buildEvaluateExpression(opts: InPageOptions): string {
  return `(${buildInPageScript()})(${JSON.stringify(opts)})`;
}

let cachedOutlineScript: string | undefined;

/** Same bundle, different entry point: `(opts) => RawOutline`. */
export function buildOutlineExpression(opts: OutlineOptions): string {
  if (!cachedOutlineScript) {
    const body = IN_PAGE_FUNCTIONS.map(fnSource).join("\n");
    cachedOutlineScript = `(function (opts) {\n${body}\nreturn __qaOutline(opts);\n})`;
  }
  return `(${cachedOutlineScript})(${JSON.stringify(opts)})`;
}

/**
 * Pre-navigation instrumentation (context.addInitScript): records elements
 * that attach a *closed* shadow root, since the platform offers no way to
 * detect them after the fact. The original attachShadow behavior is fully
 * preserved — the page is observed, never mutated. Declarative shadow DOM
 * closed roots (parsed before scripts run) remain undetectable; this
 * limitation is documented in the README.
 */
export const CLOSED_SHADOW_INIT_SCRIPT = `(() => {
  const hosts = new WeakSet();
  const original = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = original.call(this, init);
    if (init && init.mode === "closed") hosts.add(this);
    return root;
  };
  Object.defineProperty(window, "__qaMcpClosedShadowHosts", { value: hosts, enumerable: false });
})();`;
