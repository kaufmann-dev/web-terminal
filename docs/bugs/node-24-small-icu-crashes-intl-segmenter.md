# Node 24 Small ICU Crashes Intl.Segmenter

- Fixed: 2026-10-10 21:34:28 UTC (+0000)
- Pre-fix commit: `19056a37b78cf318094731b2bf97a18f8c338b16`

## Symptom

In the deployed web terminal, `pnpm build` and `pnpm dev` of a SvelteKit project using the
Paraglide Vite plugin died with `Segmentation fault` (exit 139, "dumped core") right after
"Compilation complete". The same crash reproduced on an unchanged earlier commit, and `vitest`
worked, which made the plugin look responsible. Independently, `de-AT` dates and numbers were
formatted as English (`10/10/2026`, `1,234,567.5` instead of `10.10.2026`, `1 234 567,5`).

## Confirmed Root Cause

The CentOS/EPEL `nodejs24` package is built with small ICU (`process.config.variables.icu_small`
is `true`, locales `en,root`) and expects its data in `/usr/share/node-24/icudata`. That
directory is provided only by the separate `nodejs24-full-i18n` package, which the image did not
install. Without the data, `new Intl.Segmenter().segment('abc')` dereferences missing break-iterator
data and segfaults the process (it does not throw), and every locale other than `en` silently falls
back to English.

Paraglide only triggered it indirectly: after compiling it logs through `consola`, whose fancy
reporter measures text width with `Intl.Segmenter`. `consola` switches to its basic reporter when
`NODE_ENV=test` or `CI` is set, which is why `vitest` and `CI=true` hid the crash. Calling
`compile()` directly, tracing the plugin's `buildStart`, and calling `consola.success()` alone
narrowed the crash to `Intl.Segmenter`. Extracting the `nodejs24-full-i18n` RPM data and running
`node --icu-data-dir=<data>` made `Intl.Segmenter` and `de-AT` formatting work.

## Changes

- Installed `nodejs24-full-i18n` (about 32 MB installed, 9 MB download) next to `nodejs24`.
- Added a build-time check that fails the image build unless `Intl.Segmenter` works and
  `de-AT` formats an epoch date as `1.1.1970`.
- Added regression coverage for the package and the check in `test/websocket.test.js`.
- Documented in `AGENTS.md` and `README.md` that the full ICU data must be installed with
  `nodejs24`.

After the rebuild, `pnpm build` and `pnpm dev` of the affected project run without `CI=true`.
