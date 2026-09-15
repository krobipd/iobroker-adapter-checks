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
| `stop-instance` | `common.supportedMessages.stopInstance` set in the manifest | the host kills the process instead of asking it to stop — `onUnload` never runs and every shutdown write is lost |
| `sentry-disclosure` | an adapter shipping the Sentry plugin without saying so in its README | crash reports leave the user's machine and nothing on the page mentions it |
| `error-text-selfstate` | a reason text that restates the adapter's own run state ("adapter is stopped") | it occupies the slot meant for the real cause, and the user already sees that the instance is off |
| `local-artifacts` | a local artifact in the repository root — `node_modules`, `.dev-server`, `coverage`, `.env` — that no .gitignore rule covers | the next broad `git add` publishes a working directory, dev-server profiles carry the developer's hostname |
| `issue-forms` | no issue form, a `config.yml` that still allows blank issues, or a legacy Markdown template beside the forms | reports arrive without version, log or steps, and the first reply is a question back to the reporter |
| `first-reply-workflow` | no workflow reacting to `issues: opened` (repositories of a centrally managed organisation are left alone) | every report waits for a human to ask the fixed questions; a report against an outdated version looks like a regression |
| `release-deploy-gate` | a tag-triggered deploy whose test jobs skip their steps on tags while nothing waits for the branch run of the same commit (or the wait lacks `actions: read`) | a tagged release can publish a tree nobody tested — the dependencies are green because they were skipped |
| `common-docs` | `common.docs` missing a language, not starting with `docs/<lang>/README.md`, linking a file that does not exist, leaving a page in `docs/<lang>/` unlinked, or carrying different chapters in `en` and `de` | the documentation portal shows exactly the linked pages — an unlinked page is invisible, a missing language falls back to the README, and a chapter present in one language only leaves the other language's readers without it |
| `instance-objects-refresh` | a manifest object (`instanceObjects`) that no `extendObject("<id>", …)` below `src/` refreshes, or one refreshed only in a method nothing calls | js-controller applies the manifest on every start but preserves `common.name` — a renamed object keeps its old name on every existing installation, and neither lint nor tsc see a call site that was dropped |
| `messagebox-repair` | code that repairs `common.supportedMessages` by writing an object instead of `null`, or that triggers the repair on `stopInstance` instead of on the key existing; for an adapter whose manifest declares a real entry (`deviceManager`) the opposite — deleting the key | `supportedMessages` is a positive list: with an object there and no value other than `false`, the host never subscribes to messages — no `sendTo` reaches the adapter, without a log line |
| `listen-port-declaration` | an adapter that opens a socket without declaring its ports in `fleet.json` (`listenPorts`), a declared primary port that is not a number in `native.port`, a listen address stored under any key but `native.bind` (`bindAddress`, `BIND`), a port field that is not of type `port` (or, for a protocol-fixed port, not disabled with `min = max`), a `bind` field that is not an `ip` field offering 0.0.0.0 — and `native.bind` on an adapter that declares no listener | the admin's port-conflict check ("Port is already used by X") only sees instances carrying both `native.port` and `native.bind` — measured on the official repository, 145 of 801 adapters declare the port and only 38 the bind; a listener stored otherwise is invisible, and a client adapter carrying `bind` would be reported as holding the port of its peer |

Each check reads only the adapter it is pointed at and never writes.

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
