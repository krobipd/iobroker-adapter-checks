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

Each check reads only the adapter it is pointed at and never writes.

## Options

`runChecks(dir, options)` and every `check.run(dir, options)` accept:

| option | effect |
|--------|--------|
| `skip` | check ids to leave out |
| `maxChangelogLineLength` | switches on the release-note length rule (off by default — ioBroker has no such limit; the repository checker counts entries, not characters) |

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## Origin

These started as python scripts in a private release toolchain. mcm1957 asked for
JavaScript so they can run on every dev system
([ioBroker.yamaha#609](https://github.com/iobroker-community-adapters/ioBroker.yamaha/issues/609));
this package is that migration. Every check was verified against the python original on
eleven adapters: same finding, same silence.
