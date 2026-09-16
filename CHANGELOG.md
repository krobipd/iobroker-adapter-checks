# Changelog

Written for the developer who pulls this package in: new checks, changed findings,
changed defaults, changed signatures.

## 0.8.0 (2026-09-16)

Upgrading from 0.7.x adds one check to `allChecks`: a test file or fixture that replaces `fetch`
and answers with an object that only imitates a `Response` turns red without a code change. Fix the
finding (`new Response(body, { status, headers })` — global in Node ≥ 18, also inside a `.cjs`
fixture), or leave the check out with a written reason (see README, Options).

- New check `fetch-stub-response` — judged are `src/**/*.test.ts` and every script below `test/`:
  a file that stubs `fetch` (`vi.stubGlobal("fetch", …)`, `globalThis.fetch = …`,
  `vi.spyOn(globalThis, "fetch")`) and contains an object literal with a function-valued `json` or
  `text` member is reported at that member. Measured on ioBroker.ai-usage (2026-09-16): the unit
  test and the inventory fixture answered `fetch` with `{ ok, status, json: () => …, text: () => … }`
  — no `body`, no `headers`, no `clone()`; when the adapter started to read the body as a stream,
  every provider returned an empty string and the inventory run failed while the fixture looked
  healthy, and the unit test had reported the size-cap path as tested without ever reaching it.
  Measured before the release: 3 findings in one of 12 fleet adapters (homeconnect, three literals
  in `src/lib/http.test.ts`), 0 in 13 foreign adapters; data fields (`text: "hello"`), files that
  stub something else, comments, production sources and `.d.ts` files are not reported.

## 0.7.1 (2026-09-16)

No new check. `messagebox-repair` now sees all three write forms a repair takes: the object literal
handed to `extendObject` (`supportedMessages: null`), an assignment into a patch object
(`common.supportedMessages = null`) and `delete obj.common.supportedMessages` before a full-object
write. Until now only the literal counted as a write — an adapter using one of the other two forms was
never judged, so an object written by assignment (`common.supportedMessages = { stopInstance: false }`)
and a `stopInstance` guard next to a `delete` stayed silent, and a device-manager adapter deleting its
key by assignment or `delete` was not reported either. Comparisons (`===`, `==`) are not writes.
Measured before the release: 0 findings across 12 fleet adapters and 13 foreign adapters, the two
prepared defects (assignment object, delete with a `stopInstance` guard) are reported with their line.

## 0.7.0 (2026-09-15)

Upgrading from 0.6.0 adds one check to `allChecks`: an adapter that opens a socket without declaring
its ports, or that declares them in a way the admin cannot read, turns red without a code change.
Fix the finding, or leave the check out with a written reason (see README, Options).

- New check `listen-port-declaration` — the admin's port-conflict check ("Port is already used by
  X") only sees instances on the same host that carry both `native.port` and `native.bind`
  (measured on the 801 adapters of the official repository: 145 declare the port, 38 also the
  bind). An adapter that opens a socket (`createServer`, `listen`, `createSocket` below `src/`,
  comments ignored) declares every port in its `fleet.json` under `listenPorts`
  (`{key, protocol: tcp|udp, role: primary|secondary|shared|perDevice, fixed?}`, exactly one
  `primary`); the check then holds manifest and settings form to it: `native.port` a number
  (equal to `fixed` when set), `native.bind` the only listen-address key (`bindAddress` and `BIND`
  are reported), the port field of type `port` with `min`/`max` — disabled and pinned to
  `min = max` when the protocol fixes the port, because the jsonConfig schema allows no
  `readOnly` there — and the `bind` field an `ip` field with `listenOnAllPorts`; without a field
  the manifest's bind must be `0.0.0.0`. Shared ports (SSDP 1900) must not use the key `port`: the
  admin compares numbers only and would warn every UPnP user. A client adapter carrying
  `native.bind` is reported too — its `native.port` is the port of the peer, and the admin would
  name it as the holder. An adapter without a socket and without a declaration is not judged.

## 0.6.0 (2026-09-14)

Upgrading from 0.5.0 adds three checks to `allChecks`: an adapter without complete user
documentation under `common.docs`, with a manifest object that reachable code never refreshes,
or with a `supportedMessages` repair that shuts its own messagebox turns red without a code
change. Fix the finding, or leave a check out with a written reason (see README, Options).

- New check `common-docs` — `common.docs` links the pages the ioBroker documentation portal
  shows: both `en` and `de`, `docs/<lang>/README.md` first (changelog, logo and badges land
  there), every linked file exists, no page in `docs/<lang>/` is left unlinked (it would be
  invisible), and both languages carry the same chapters.
- New check `instance-objects-refresh` — every `instanceObjects` entry is refreshed with
  `extendObject("<id>", …)` below `src/`, from a method that is itself called. js-controller
  applies the manifest on every start but preserves `common.name` (measured on 7.2.2): a renamed
  object reaches new installations only. The second half is measured, not theoretical —
  dropping just the call line from `onReady` leaves method and call in place, lint and tsc stay
  green, and no installation is reached. Findings for a dead method point at the file and line
  of the call; an adapter without TypeScript sources below `src/` is not judged.
- New check `messagebox-repair` — an adapter repairing `common.supportedMessages` must write
  `null` (deletes the key; an object keeps it and shuts the box) and trigger on the key existing
  at all (a guard on `stopInstance` never matches its own written state). Measured on
  js-controller 7.2.2: `{stopInstance: false}` → no message arrives. An adapter whose manifest
  declares a real entry (`deviceManager: true`) is judged the other way round — deleting the
  key would switch its box off. Comments are removed before searching; the trigger rule applies
  only where the adapter writes the key, so an adapter that merely reads the field or handles a
  `stopInstance` message is left alone. Every occurrence is reported with its line.
- Test: every file in `src/checks/` is wired into `allChecks` under its file name as id — a
  check that exists but is not exported never runs in any adapter.

## 0.5.0 (2026-09-08)

Upgrading from 0.4.0 adds three checks to `allChecks`: a repository without issue forms,
without a first-reply workflow, or with a tag-only deploy that skips its tests turns red
without a code change. Add the forms/workflow, or leave a check out with a written reason
(see README, Options).

- New check `issue-forms` — every new report goes through a form: at least one issue form
  (`name:` + `body:`), a `config.yml` with `blank_issues_enabled: false`, and no legacy
  Markdown template beside the forms (GitHub offers it as a second, unguided entry).
- New check `first-reply-workflow` — a workflow reacts to `issues: opened`, so the fixed
  questions are asked immediately and a report against an outdated version is flagged before
  a human reads it. Repositories of a centrally managed organisation
  (`iobroker-community-adapters`) are left alone: their workflows are the organisation's.
- New check `release-deploy-gate` — a tag-triggered deploy whose test jobs skip their steps
  on tags must wait for the branch run of the same commit (`actions/github-script` +
  `listWorkflowRuns`, with `actions: read`). Without that the dependencies are green because
  they were skipped, and the release publishes a tree nobody tested. The standard form (tests
  run on the tag as well) passes untouched.
- Changed: `node-matrix` reads the workflow with comments removed — a commented-out
  `node-version:` line no longer counts as a matrix entry (the check can only get quieter).

## 0.4.0 (2026-09-04)

- New check `stop-instance` — `common.supportedMessages.stopInstance` in the manifest. With
  the entry present the host kills the process on shutdown instead of asking it to stop, so
  `onUnload` never runs and every write meant for shutdown is dead code. Measured against
  js-controller 7.2.2: `terminated due to SIGKILL` instead of `ADAPTER_REQUESTED_TERMINATION`.
  What the user sees: devices stay green in the tree while the instance is off. `deviceManager`
  under the same key stays allowed.
- New check `sentry-disclosure` — an adapter that ships the Sentry plugin has to say so in its
  README, with the badge in the header and a `## Sentry` section. Conditional: without the
  plugin the check stays silent.
- New check `error-text-selfstate` — a reason text next to an `info.error` write that merely
  restates the adapter's own run state. It occupies the slot where the real cause belongs, and
  the user already sees that the instance is off.
- `admin-i18n` also compares the key sets: english is the reference, so a key missing from one
  language or existing only outside english is reported. Each file on its own looked fine
  before, which is exactly why a forgotten translation or a leftover key went unnoticed.

## 0.3.0 (2026-08-23)

- New check `local-artifacts` — a local artifact sitting in the repository root that no
  .gitignore rule covers. Reported for `node_modules`, `.dev-server`, `coverage` and
  `.env`, and only once the artifact actually exists, so a repository that never runs the
  tool creating it is never asked to ignore it. Written after a throwaway dev-server
  profile reached a public adapter repository, developer hostname included, because that
  one .gitignore lacked the entry the sibling repositories had.

## 0.2.1 (2026-08-22)

- `admin-i18n` reports five more machine mistranslations. The python original carried
  nine, the first port only four: `Lüszel`, `Stall` (English "stall" as the German barn)
  and an adapter name that a translation service translated — `Paketapp`, `paquetapp`,
  `paccoapp`. Matched case-sensitively, so `Install` is not read as `Stall`.

## 0.2.0 (2026-08-22)

- New check `admin-i18n` — compares the translatable texts of the settings page against
  the shipped language files. Reports missing languages, missing individual texts, both
  i18n layouts side by side, a manifest naming the wrong dialect, and four machine
  mistranslations.
- New check `readme-requirements` — reports a README that promises an older js-controller,
  admin or Node than the adapter actually requires.
- New check `english-only` — German prose in the README or in `common.news[*].en`. Link
  lines are exempt: a wiki page title may be German without the sentence being German.
- New check `changelog-style` — release notes that name build tools, test runners or
  internal identifiers.
- `Check.run()` takes a second parameter: `run(adapterDir, options?)`. Optional, existing
  calls keep working.
- New option `maxChangelogLineLength`, off by default. ioBroker has no line-length rule —
  the repository checker counts entries, not characters — so the package does not impose
  one.
- Findings report paths with forward slashes on every platform, Windows included.

## 0.1.0 (2026-08-22)

First release with four checks: `switch-default`, `changelog-count`, `node-matrix` and
`secret-fields`.
