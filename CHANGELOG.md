# Changelog

Written for the developer who pulls this package in: new checks, changed findings,
changed defaults, changed signatures.

## 0.11.1 (2026-09-17)

0.11.0 never reached npm: the windows leg of its release run failed on a platform-dependent unit
test of `listSourceFiles` (the walker returns backslashes there, the test compared against
forward slashes). 0.11.1 is the same package with that test fixed — no check changed.

## 0.11.0 (2026-09-17)

Upgrading from 0.10.x adds one check to `allChecks`. An adapter that turns a caught value into text
with `String(err)`, `${err}`, `(err as Error).message` or a bare `JSON.stringify(err)` turns red
without a code change; the fix is one helper that handles every thrown value, and every catch site
routed through it.

- New check `caught-value-text` — a caught value (the variable of a `catch` clause, the parameter
  of a `.catch(…)` or `.then(…, …)` rejection handler, and every parameter such a value is passed
  to — a helper in the same file or behind a relative import, a class method, a bound function)
  rendered with `String()`, inside a template literal, read as `(… as Error).message` /
  `(<Error>…).message`, or passed to `JSON.stringify` outside a try/catch of the same function.
  Judged below `src/` and, for an Admin 8 component, below `src-admin/src/` (`.ts` and `.tsx`).
  A rendering is accepted where the value cannot be an object: on a branch of `typeof err !==
  "object"`, `typeof err === "string"` (any primitive name), `err === null`/`undefined`, `!err`,
  `err instanceof Error` (any `…Error`/`…Exception` class), combined with `&&`/`||`/`!`, and after
  an early `return`/`throw` behind such a guard — the three helper forms the fleet carries pass
  unchanged. The inline `err instanceof Error ? err.message : String(err)` is the finding it was
  built for: its else branch renders a thrown plain object as `[object Object]`. Judged with the
  adapter's own `typescript`; without a loadable compiler the check reports that instead of
  staying silent. Measured before the release: 62 findings in 9 of 12 fleet adapters (hassemu 37,
  yamaha 10, fakeroku 4, hueemu 4, homewizard 2, nut2 2, ai-usage 1, govee-smart 1 in
  `src-admin/`, public-holidays 1); in the six foreign adapters with TypeScript sources 105
  (hm-rpc 57 — every one the cast form of the create-adapter template's `onUnload` —, devices 22,
  javascript 13, influxdb 6, harmony 5, lgtv 2; seven JavaScript-only adapters are not judged),
  plus 126 in four non-adapter repositories (zigbee-herdsman-converters 121, @iobroker/testing 3,
  legacy-testing 1, adapter-react-v5 1). 22 of the fleet findings and 11 of the foreign ones were read
  in context, all true; one false positive met on the way (a helper whose object branch is a try/catch
  that returns on both arms) was closed before the release.

## 0.10.0 (2026-09-16)

Upgrading from 0.9.x adds one check to `allChecks`. An adapter that calls a method its installed
`@iobroker/types` marks `@deprecated` turns red without a code change; the fix is the method the tag
names (`setState` for `setStateAsync`, `extendObject` for `extendObjectAsync`, `delObject` for
`deleteState`, …) — and the test doubles that stub the old name move with it.

- New check `deprecated-adapter-methods` — a call on the adapter (`this` in a class that extends
  `…Adapter`, `adapter`, `….adapter`) to a method whose declaration in the INSTALLED
  `@iobroker/types` (`node_modules/@iobroker/types/build/*.d.ts`) carries `@deprecated`, reported
  with the tag's advice and the package version. The list is derived, never copied: for 7.2.2 that
  is `setStateAsync`, `extendObjectAsync`, `setObjectAsync`, `setForeignObjectAsync`,
  `createState`/`createChannel`/`createDevice`, `deleteState`/`deleteChannel`/`deleteDevice` and
  their `…Async` twins; an adapter on 7.0.7 gets the 7.0.7 list. A library class with its own
  `createState` method is not reported (the receiver decides); a tag's text ends at the line end or
  the comment end, whichever comes first, so a tag closed on its own line is never pinned to the next
  method. Silent without `node_modules/@iobroker/types` (nothing to derive from); without a loadable
  `typescript` the check reports that instead of staying silent. Measured before the release: 50
  findings in 5 of 12 fleet adapters (homewizard 26, public-holidays 17, hueemu 5, beszel 1,
  yamaha 1), 42 in 4 of 13 foreign adapters, all true for their installed version.

## 0.9.0 (2026-09-16)

Upgrading from 0.8.x adds one check to `allChecks`. It parses `src/**/*.ts` with the adapter's own
`typescript` (declared as an optional peer dependency; every TypeScript adapter carries it). An
adapter that rewrites an object by delete + create, or writes one whole with `setObject(Async)`,
turns red without a code change. Fix the finding, or leave the check out with a written reason (see
README, Options).

- New check `object-rewrite` — two findings. (1) A delete of an object (`delObject`,
  `delObjectAsync`, `delForeignObject`, `delForeignObjectAsync`) followed on the same path through
  the function by a create or write of the same first argument on the same receiver
  (`setObjectNotExists`, `extendObject`, `setObject`, `setForeignObject` and their relatives): a
  `return`, `throw`, `break` or `continue` between them ends the path (an orphan cleanup that
  returns is not paired with a create in a later branch), a `try` around the delete does not. Measured
  on `@iobroker/js-controller-adapter` 7.2.2: `_delForeignObject` deletes the object, then calls
  `delForeignState` for a state (the value is gone) and `removeIdFromAllEnums` (the user's room and
  function assignments are gone) — nothing the recreate writes brings them back. (2) A whole-object
  write with `setObject` or `setObjectAsync` on the adapter itself (`this` in a class that extends
  `…Adapter`, `adapter`, `….adapter`): the repository checker refuses `setObject` (S5054), and
  `setObjectAsync` is the same call, deprecated in `@iobroker/types` 7.2.2 and merely unseen by the
  checker's method list. The form the check asks for when a key has to go: read the object, remove
  the key from the copy, `setForeignObject(fullId, copy)` — one write, value and enums untouched. A
  move (delete of one id, create of another) and a plain delete are not judged; without a loadable
  `typescript` the check reports that instead of staying silent. Measured before the release: 4
  findings in 4 of 12 fleet adapters (hassemu `src/lib/object-repair.ts:43`, yamaha
  `src/main.ts:1035` — the delete pair; hueemu `src/main.ts:700`, homewizard
  `src/lib/state-manager.ts:1042` — `setObjectAsync`), every one a true rewrite of a state object;
  11 in 3 of 13 foreign adapters, all whole-object writes.
- New helper `adapter-api` (internal): the method calls of a source file with receiver, adapter
  detection, arguments and line, plus the same-path walk the delete pair uses; `typescript` is loaded
  through `createRequire` from the package's install location, i.e. the adapter's copy.

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
