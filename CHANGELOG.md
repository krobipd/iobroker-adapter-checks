# Changelog

Written for the developer who pulls this package in: new checks, changed findings,
changed defaults, changed signatures.

## 0.6.0 (2026-09-12)

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
