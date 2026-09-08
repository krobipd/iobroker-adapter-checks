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
