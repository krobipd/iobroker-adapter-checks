# iobroker-adapter-checks

Repository standard checks for ioBroker adapters. Plain JavaScript, no python, no network,
no child processes — it reads files and returns findings, so it runs as an ordinary unit
test on any developer machine and in CI.

## Use

```ts
// test/standards/repo-standards.test.ts
import { join } from "node:path";
import { allChecks, formatFindings } from "iobroker-adapter-checks";

const adapterDir = join(__dirname, "..", "..");

describe("repository standards", () => {
  for (const check of allChecks) {
    it(check.title, () => {
      expect(formatFindings(check.run(adapterDir))).toBe("");
    });
  }
});
```

vitest must be told to look outside `src/`:

```ts
include: ["src/**/*.test.ts", "test/standards/*.test.ts"],
```

The ioBroker test action runs `npm run test:unit`, so the checks then run in the standard
matrix without any workflow change.

## Checks

| id | what it catches | why it matters |
|----|-----------------|----------------|
| `switch-default` | a `switch` over a message command without `default:` | an unknown command never answers the caller — it hangs until the ioBroker timeout |
| `changelog-count` | more than 7 versioned entries in the README changelog | repochecker E6006 |
| `node-matrix` | a CI matrix entry below `engines.node` | the install fails with EBADENGINE |
| `secret-fields` | `encryptedNative` / `protectedNative` nested under `common` | js-controller ignores them there — credentials end up unencrypted |
| `english-only` | German prose in README or in `common.news[*].en` | repochecker guards the README (E6015) but never looks at the release notes |
| `changelog-style` | release notes that name build tools, test runners or internal identifiers | that text is what users read in the admin update dialog |
| `admin-i18n` | settings-page texts missing from a shipped language | the admin shows a half-translated dialog |
| `readme-requirements` | README promising an older js-controller, admin or Node than the adapter needs | the user follows the README and the install refuses the adapter |
| `stop-instance` | `common.supportedMessages.stopInstance` set in the manifest, or a `supportedMessages` object without any value other than `false` | the host kills the process instead of asking it to stop — `onUnload` never runs; an all-`false` list turns the messagebox off and every `sendTo` goes nowhere |
| `sentry-disclosure` | an adapter shipping the Sentry plugin without the repository checker's Sentry notice near the top (before the fifth `##` heading) | crash reports leave the user's machine and nothing near the top of the page mentions it (W6023/W6024) |
| `error-text-selfstate` | a reason text that restates the adapter's own run state ("adapter is stopped") | it occupies the slot meant for the real cause, and the user already sees that the instance is off |
| `local-artifacts` | a local artifact in the repository root — `node_modules`, `.dev-server`, `coverage`, `.env` — that no .gitignore rule covers | the next broad `git add` publishes a working directory, dev-server profiles carry the developer's hostname |
| `issue-forms` | no issue form, a `config.yml` that still allows blank issues, or a legacy Markdown template beside the forms | reports arrive without version, log or steps, and the first reply is a question back to the reporter |
| `first-reply-workflow` | no workflow reacting to `issues: opened` (repositories of a centrally managed organisation are left alone) | every report waits for a human to ask the fixed questions; a report against an outdated version looks like a regression |
| `release-deploy-gate` | a tag-triggered deploy whose test jobs skip their steps on tags while nothing waits for the branch run of the same commit (or the wait lacks `actions: read`) | a tagged release can publish a tree nobody tested — the dependencies are green because they were skipped |
| `common-docs` | `common.docs` missing a language, not starting with `docs/<lang>/README.md`, linking a file that does not exist, leaving a page in `docs/<lang>/` unlinked, or carrying different chapters in `en` and `de` | the documentation portal shows exactly the linked pages — an unlinked page is invisible, a missing language falls back to the README, and a chapter present in one language only leaves the other language's readers without it |
| `instance-objects-refresh` | a manifest object (`instanceObjects`) that no `extendObject("<id>", …)` below `src/` refreshes, or one refreshed only in a method nothing calls | js-controller applies the manifest on every start but preserves `common.name` — a renamed object keeps its old name on every existing installation, and neither lint nor tsc see a call site that was dropped |
| `messagebox-repair` | code that repairs `common.supportedMessages` by writing an object instead of deleting the key (`: null`, `= null` or `delete …`), or that triggers the repair on `stopInstance` instead of on the key existing; for an adapter whose manifest declares a real entry (`deviceManager`) the opposite — deleting the key | `supportedMessages` is a positive list: with an object there and no value other than `false`, the host never subscribes to messages — no `sendTo` reaches the adapter, without a log line |
| `listen-port-declaration` | an adapter that opens a socket without declaring its ports in `fleet.json` (`listenPorts`), a declared primary port that is not a number in `native.port`, a listen address stored under any key but `native.bind` (`bindAddress`, `BIND`), a port field that is not of type `port` (or, for a protocol-fixed port, not disabled with `min = max`), a `bind` field that is not an `ip` field offering 0.0.0.0 — and `native.bind` on an adapter that declares no listener | the admin's port-conflict check ("Port is already used by X") only sees instances carrying both `native.port` and `native.bind` — measured on the official repository, 145 of 801 adapters declare the port and only 38 the bind; a listener stored otherwise is invisible, and a client adapter carrying `bind` would be reported as holding the port of its peer |
| `fetch-stub-response` | a test or fixture that replaces `fetch` (`vi.stubGlobal("fetch", …)`, `globalThis.fetch = …`, `vi.spyOn(globalThis, "fetch")`) and answers with a hand-built object carrying `json`/`text` methods instead of `new Response(body, { status, headers })` | the imitation has no `body`, `headers` or `clone()` — code that reads the stream (`response.body.getReader()`) sees `undefined`, and the test reports a path as covered that it never ran (ai-usage 2026-09-16: every provider returned an empty string while the fixture looked healthy) |
| `object-rewrite` | an object rewritten by `delObject` + `setObjectNotExists`/`extendObject` of the same id on the same path through a function, or written whole with `setObject`/`setObjectAsync` on the adapter | a deleted state object loses its value and its enum memberships (the user's room and function assignments — `_delForeignObject` calls `delForeignState` and `removeIdFromAllEnums`), and nothing the recreate writes brings them back; `setObject` is the repository checker's S5054 and `setObjectAsync` the same call unseen by its list. Dropping a key from an existing object is one write: read it, remove the key from the copy, `setForeignObject(fullId, copy)` |
| `deprecated-adapter-methods` | a call on the adapter (`this` in a class extending `…Adapter`, `adapter`, `….adapter`) to a method the INSTALLED `@iobroker/types` marks `@deprecated` — read from its declaration files, so the list follows the version the adapter resolves (7.2.2: `setStateAsync`, `extendObjectAsync`, `setObjectAsync`, `setForeignObjectAsync`, `createState`, `deleteState` and their relatives) | a deprecated method is the next removal; the adapter's own type check already shows it struck through. Silent without `node_modules/@iobroker/types`
| `caught-value-text` | a caught value — the variable of a `catch`, the parameter of a `.catch(…)`/`.then(…, …)` rejection handler, a copy of it (`const err = error as Error`), the `reason` of a rejected `Promise.allSettled` result, or the parameter of any helper such a value is passed to — turned into text with `String(err)`, `${err}`, `(err as Error).message` or a bare `JSON.stringify(err)`, outside a branch that rules an object out (`typeof err !== "object"`, `err instanceof Error`, …) — and its `.message` shown as text (a template, `+`, a call or `new` argument, a `return`, an object property) in any branch, unless the same function reads its `.cause`; below `src/` and, for an Admin 8 component, `src-admin/src/` | JavaScript lets code throw anything: `String()` and a template render a thrown plain object (a rejected `{ code: "ECONNRESET" }`, an HTTP client's error object) as `[object Object]`, a template on a thrown symbol throws again inside the catch block, the cast reads `undefined` off a thrown string, and `JSON.stringify` throws on a circular structure; an Error's `.message` alone drops its reason — Node's `fetch` rejects every network failure as `fetch failed` with the reason only in `cause`. One helper handles every thrown value: Error → message (its `code` when empty) with one level of `cause`, string → itself, other primitives → `String()`, objects → `JSON.stringify` inside try/catch with `Object.prototype.toString.call` as the fallback |
| `error-text-helper` | a second function carrying the object branch of the error-text helper (`JSON.stringify(…)` together with `Object.prototype.toString.call(…)`) below `src/` or `src-admin/src/` | a copy drifts from the helper it was taken from; the reason given for Admin copies ("the component cannot import `src/`") is a declaration file the build writes next to the imported source — the Admin component imports the adapter's helper from `src/` (with `dts: false` in the module-federation plugin the build writes no declaration next to the source) |
| `error-text-reason` | the repository's error-text helper (the first function below `src/` carrying the object branch) whose body never reads a property `cause` or never reads a property `code` — a structural proxy: it proves the helper looks at both, its own tests prove the words | ES2022 gave `Error` a `cause`, and Node's `fetch` rejects with `new TypeError("fetch failed", { cause })` — an unreachable host, a refused port and a dropped socket all read `fetch failed` when the helper returns the message alone; `http.get` and `net.connect` to `localhost` reject with an `AggregateError` whose message is empty and whose `code` is `ECONNREFUSED`, so the message alone is nothing (Node 22.22.2). Render the message (its `code` when empty) and one level of `cause`: `fetch failed (getaddrinfo ENOTFOUND host)` |
| `object-delete-drops-state` | `delState`/`delForeignState` (or their `Async` twins) right before or after `delObject`/`delForeignObject` of the same id on the adapter, on the same path through a function | js-controller deletes the value of a state object together with the object (`_delForeignObject` → `delForeignState`, plus the enum memberships — since 1.x): the extra delete is a second round trip per object and a comment that misleads the next cleanup routine. A `delState` on its own (an orphan value) is not judged |
| `fire-and-forget-rejection` | a promise dropped with `void` whose rejection has no receiver: the callee (a method of the class, a function of the file or behind a relative import, an immediately invoked arrow) lets an `await`, a `for await`, a `throw`, a returned promise or an own helper that throws escape its try/catch — before the `try`, after the `catch`, inside a `try` without catch clause, or as a rethrow in the catch clause — or a `.then(…)` chain without `.catch(…)` whose root or callback can reject; an awaited own function whose body is one try/catch is no risk, and a callee the check cannot resolve (`setState`, a library) is not judged | an unhandled rejection ends the instance: js-controller logs it and stops the process (`_exceptionHandler`, exit code UNCAUGHT_EXCEPTION), and whatever the call was writing is lost. Below `src/`; synchronous calls the check cannot resolve (a logger, `Object.keys`) are not read |
| `read-stub-copy` | a test stub of an adapter read method (`getObject`, `getForeignObject`, `getForeignObjects`, `getState`, `getForeignState`, `getStates`, `getEnums`, `getObjectView`, … and their `Async` twins) that answers with the object it keeps — a lookup (`store.get(id)`, `objects[id]`), a member of the harness (`this.instanceObject`) or a variable declared outside the stub — followed through `Promise.resolve`, `await`, `??`, `?:` and the stub's own variables; a callback-form name (`getStates`) counts only next to another adapter member or on a receiver called `adapter`/`this`, because other libraries a test fakes use the same names | the controller hands every read a fresh value — with a shared reference a change the code makes on what it read is in the store before any write, so no test can tell a missing write from a done one (hassemu 2026-09-17: the repair path's write was invisible to every test); answer with `structuredClone(obj)`, null stays null |

Each check reads only the adapter it is pointed at and never writes. `object-rewrite`,
`deprecated-adapter-methods`, `caught-value-text`, `error-text-helper`, `error-text-reason`, `object-delete-drops-state`,
`fire-and-forget-rejection` and `read-stub-copy` parse the sources with the adapter's own `typescript` (an optional
peer dependency — every TypeScript adapter has it); when no compiler can be loaded they report that
as a finding instead of staying silent.

## Options

`runChecks(dir, options)` and every `check.run(dir, options)` accept:

| option | effect |
|--------|--------|
| `skip` | check ids to leave out |
| `maxChangelogLineLength` | switches on the release-note length rule (off by default — ioBroker has no such limit; the repository checker counts entries, not characters) |

A repository that iterates `allChecks` itself leaves a check out by filtering the list — for example `allChecks.filter((c) => c.id !== "first-reply-workflow")` — with the reason written next to it.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Origin

These started as python scripts in a private release toolchain. mcm1957 asked for
JavaScript so they can run on every dev system
([ioBroker.yamaha#609](https://github.com/iobroker-community-adapters/ioBroker.yamaha/issues/609));
this package is that migration. Every check was verified against the python original on
eleven adapters: same finding, same silence.
