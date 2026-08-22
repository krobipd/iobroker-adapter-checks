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

Each check reads only the adapter it is pointed at and never writes.

## Origin

These started as python scripts in a private release toolchain. mcm1957 asked for
JavaScript so they can run on every dev system
([ioBroker.yamaha#609](https://github.com/iobroker-community-adapters/ioBroker.yamaha/issues/609));
this package is that migration. Every check was verified against the python original on
eleven adapters: same finding, same silence.
