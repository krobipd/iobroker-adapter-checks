# Changelog

Written for the developer who pulls this package in: new checks, changed findings,
changed defaults, changed signatures.

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
