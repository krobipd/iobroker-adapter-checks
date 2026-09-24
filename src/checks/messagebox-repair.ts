import type TS from "typescript";
import { typescriptApi } from "../adapter-api.js";
import type { Check, Finding } from "../types.js";
import {
  listSourceFiles,
  readJson,
  readText,
  repoPath,
  stripTsComments,
} from "../util.js";

/**
 * A write into the key, in the three forms the fleet uses (measured 2026-09-16): an object
 * literal handed to `extendObject` (`supportedMessages: null`), an assignment into a patch object
 * (`common.supportedMessages = null`) and `delete obj.common.supportedMessages`
 * before a full-object write. A single `=` only — `===`/`==` is a comparison, not a
 * write. Until 0.7.1 only the literal form counted, so rule (2) was unreachable for the other two
 * and an object written by assignment was silent.
 */
const WRITE = String.raw`supportedMessages\s*(?::|=(?!=))\s*`;
/** The adapter deletes the key — `null` in a merge, `null` by assignment, or `delete`. */
const DELETES_KEY = new RegExp(
  String.raw`${WRITE}null|\bdelete\s+[\w$.?!\[\]"']*?\bsupportedMessages\b`,
  "g",
);
/** The adapter writes an object into the key — keeps it, with whatever is inside. */
const WRITES_OBJECT = new RegExp(String.raw`${WRITE}\{`, "g");
/** Any write to the key, either form: only then is there a repair to judge. */
const WRITES_KEY = new RegExp(
  String.raw`${WRITE}(?:null|\{)|\bdelete\s+[\w$.?!\[\]"']*?\bsupportedMessages\b`,
);

/** Offsets of the code that a rule judges, read off the syntax tree (0.15.0). */
interface Sites {
  /** Object literals written into the key — `supportedMessages: {…}` as a value, `x.supportedMessages = {…}`. */
  objectWrites: number[];
  /** `stopInstance` as code: an identifier, `obj["stopInstance"]`, `"stopInstance" in obj` — never a type or a text. */
  stopMentions: number[];
}

/**
 * Where the file writes an object into the key and where its CODE names `stopInstance`, from the TypeScript tree.
 * Until 0.15.0 both were regexes over the text: a type annotation `supportedMessages: { stopInstance?: boolean }`
 * counted as an object write, a log line naming `stopInstance` as the guard (tooling audit 2026-09-24, P7).
 *
 * @param ts the TypeScript compiler API
 * @param text the file
 * @returns the offsets
 */
function sitesOf(ts: typeof TS, text: string): Sites {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const sites: Sites = { objectWrites: [], stopMentions: [] };
  const named = (n: TS.Node | undefined, name: string): boolean =>
    !!n &&
    ((ts.isIdentifier(n) && n.text === name) ||
      (ts.isStringLiteral(n) && n.text === name));
  const inType = (n: TS.Node): boolean => {
    for (let p: TS.Node | undefined = n.parent; p; p = p.parent) {
      if (
        ts.isTypeNode(p) ||
        ts.isPropertySignature(p) ||
        ts.isInterfaceDeclaration(p) ||
        ts.isTypeAliasDeclaration(p)
      ) {
        return true;
      }
    }
    return false;
  };
  const visit = (n: TS.Node): void => {
    if (
      ts.isPropertyAssignment(n) &&
      named(n.name, "supportedMessages") &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      sites.objectWrites.push(n.getStart(sf));
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(n.right) &&
      ((ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "supportedMessages") ||
        (ts.isElementAccessExpression(n.left) &&
          named(n.left.argumentExpression, "supportedMessages")))
    ) {
      sites.objectWrites.push(n.getStart(sf));
    }
    const code =
      (ts.isIdentifier(n) && n.text === "stopInstance" && !inType(n)) ||
      (ts.isStringLiteral(n) &&
        n.text === "stopInstance" &&
        ((ts.isElementAccessExpression(n.parent) &&
          n.parent.argumentExpression === n) ||
          (ts.isBinaryExpression(n.parent) &&
            n.parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
            n.parent.left === n)));
    if (code) {
      sites.stopMentions.push(n.getStart(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

/**
 * A value as a plain object, or undefined.
 *
 * @param value anything
 * @returns the value when it is a non-null, non-array object
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 1-based line of a character offset.
 *
 * @param text the file
 * @param index offset into it
 * @returns the line number
 */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/**
 * An adapter that repairs its own `common.supportedMessages` must not shut its messagebox.
 *
 * `supportedMessages` is a POSITIVE LIST, not a switch. Measured on
 * `@iobroker/js-controller-adapter` 7.2.2:
 *
 *     utils.js   isMessageboxSupported(c):
 *         if (!isObject(c.supportedMessages)) return !!c.messagebox;
 *         return Object.values(c.supportedMessages).find(v => v !== false) !== undefined;
 *     adapter.js   else if (isMessageboxSupported(...)) { subscribeMessage(...) }
 *
 * As soon as the key is an object, `common.messagebox` is not looked at any more. Without a
 * single value other than `false` in it, `subscribeMessage` never runs — the adapter receives
 * no `sendTo` at all. The button in the settings stays active and sends; nobody listens, and
 * there is no log line. Measured on a live installation: `{stopInstance: false}` → the
 * message never arrives; `{stopInstance: false, checkConnection: true}` → it does.
 *
 * Two halves, both needed:
 *
 * 1. THE WRITTEN VALUE: `supportedMessages: null` deletes the key (the merge copies `null`
 *    and skips `undefined`). Writing an object — even `{stopInstance: false}` — keeps the key
 *    and the box shut.
 * 2. THE TRIGGER: the repair runs as soon as the key exists AT ALL. A guard on
 *    `supported?.stopInstance` never matches its own written state — the installation stays
 *    deaf for good.
 *
 * Two regimes, because the right repair depends on whether the adapter NEEDS the key:
 *
 * A) The manifest declares no `supportedMessages` (or only `false` values) — the normal
 *    case. Right is deleting the whole key, triggered by its presence. Both halves are judged.
 * B) The manifest declares a value other than `false` (`deviceManager: true`). The box is
 *    structurally on there; such an adapter cannot write itself deaf while the legitimate
 *    entry stands. The rule turns around: `supportedMessages: null` deletes the legitimate
 *    list, and since these adapters carry no `common.messagebox`, the box falls back to
 *    `!!undefined` — off. Judged is exactly the opposite, and a `stopInstance` guard is
 *    correct there (the key stays, only the one entry has to go).
 *
 * The trigger rule (2) is judged only where the adapter writes the key at all — without a
 * write there is no repair whose trigger could be wrong. An adapter that merely reads the
 * field or handles a `stopInstance` message is not a repair and is left alone.
 *
 * Comments are removed before searching: both patterns typically sit in the explanation above
 * the repair as well, and a check that reports its own documentation gets switched off.
 */
export const messageboxRepairCheck: Check = {
  id: "messagebox-repair",
  title:
    "a supportedMessages repair deletes the key and triggers on its presence",
  run(adapterDir: string): Finding[] {
    const ts = typescriptApi();
    const texts = listSourceFiles(adapterDir).map((file) => {
      const rel = repoPath(adapterDir, file);
      const raw = readText(adapterDir, rel) ?? "";
      // Without a loadable compiler the text rules stay (comments stripped) — the older, coarser reading.
      return {
        rel,
        raw,
        text: stripTsComments(raw),
        sites: ts ? sitesOf(ts, raw) : undefined,
      };
    });
    if (!texts.some((t) => t.text.includes("supportedMessages"))) {
      return [];
    }

    // Which regime applies? The MANIFEST decides, not the code.
    const iopkg = readJson<{ common?: unknown }>(adapterDir, "io-package.json");
    const declared = asObject(asObject(iopkg?.common)?.supportedMessages);
    const legitimate = declared
      ? Object.entries(declared)
          .filter(([, v]) => v !== false)
          .map(([k]) => k)
          .sort()
      : [];

    const findings: Finding[] = [];
    const report = (
      rel: string,
      text: string,
      pattern: RegExp,
      message: string,
      impact: string,
    ): void => {
      for (const m of text.matchAll(pattern)) {
        findings.push({
          check: messageboxRepairCheck.id,
          file: rel,
          line: lineOf(text, m.index),
          message,
          impact,
        });
      }
    };

    if (legitimate.length > 0) {
      // Regime B: the adapter NEEDS the positive list. Deleting it is the defect.
      for (const t of texts) {
        report(
          t.rel,
          t.text,
          DELETES_KEY,
          `the adapter deletes common.supportedMessages although its manifest declares ${legitimate.join(", ")}`,
          "that key is the positive list that switches message reception on — after the delete common.messagebox decides, which such adapters do not carry, so the messagebox is off; remove only the unwanted entry and keep the legitimate one",
        );
      }
      return findings;
    }

    const at = (
      rel: string,
      text: string,
      offsets: number[],
      message: string,
      impact: string,
    ): void => {
      for (const index of offsets) {
        findings.push({
          check: messageboxRepairCheck.id,
          file: rel,
          line: lineOf(text, index),
          message,
          impact,
        });
      }
    };
    const deletes = new RegExp(DELETES_KEY.source); // no `g`: .test() must not carry lastIndex from file to file
    const repairs = texts.some((t) =>
      t.sites
        ? t.sites.objectWrites.length > 0 || deletes.test(t.text)
        : WRITES_KEY.test(t.text),
    );
    const OBJECT_MESSAGE =
      "the adapter writes an object into common.supportedMessages instead of deleting the key";
    const OBJECT_IMPACT =
      "supportedMessages is a positive list: with an object there the host ignores common.messagebox, and without a value other than false subscribeMessage never runs — no sendTo reaches the adapter, without a log line; write { common: { supportedMessages: null } }";
    const GUARD_MESSAGE =
      "the repair is triggered by `stopInstance` instead of by the key existing at all";
    const GUARD_IMPACT =
      "a guard on stopInstance never matches its own written state — a half-repaired installation stays deaf for good; test `supported === undefined || supported === null` instead";
    for (const t of texts) {
      // 1) An object is written into supportedMessages instead of deleting the key.
      if (t.sites) {
        at(t.rel, t.raw, t.sites.objectWrites, OBJECT_MESSAGE, OBJECT_IMPACT);
      } else {
        report(t.rel, t.text, WRITES_OBJECT, OBJECT_MESSAGE, OBJECT_IMPACT);
      }
      // 2) The repair hangs on `stopInstance` instead of on the key existing. Judged as bare
      //    occurrence in the code (comments are gone): the correct guard does not need the
      //    field name at all. A regex on `supported?.stopInstance` was too narrow and let the
      //    cast form `(supported as {...})?.stopInstance` through.
      if (repairs) {
        if (t.sites) {
          at(t.rel, t.raw, t.sites.stopMentions, GUARD_MESSAGE, GUARD_IMPACT);
        } else {
          report(t.rel, t.text, /stopInstance/g, GUARD_MESSAGE, GUARD_IMPACT);
        }
      }
    }
    return findings;
  },
};
