# Contributing

Thanks for wanting to help. This is a small, focused plugin; the best contributions are bug reports with a reproducible trace and narrow, well-tested fixes.

## Ground rules

- **Never commit a token, key, or `.env`.** The `.gitignore` covers the usual cases; do not defeat it.
- **Keep the adapter structural.** The plugin must not import `@deepseek-ai/dsh-*` kernel packages — it mounts on the harness's structural `ctx` contract so it can run across kernel lines. If you need something from the kernel, reach it through `ctx`, and guard the read (see the cordis-proxy note below).
- **Respect the two hard-won invariants** (see README "踩过的坑"):
  - The provider route is `magpie-model`, never the bare `magpie` — the bare name collides with the provider magpie's handover injects into `dsh-llm-pi-ai` and degrades the whole profile.
  - The spawned gateway runs with `MAGPIE_NO_HANDOVER=1`.

## The cordis proxy trap

Reading a service that was **not** named in the plugin's `inject` throws inside the real cordis proxy (`cannot get property "X" without inject`) rather than returning `undefined`. That is why `connection` and `attachments` are read through guarded helpers. Any new service read must either be added to `inject` or wrapped in a `try`.

## Tests

```sh
node test/client-lint.mjs     # browser half: evaluates the ModuleLoader bundle, renders every card, checks zh/en key parity
node test/integration.mjs     # mock-kernel integration + (when magpie is installed) real gateway turns
node test/verify-live.mjs     # live end-to-end against a running dsh (token handshake, status, models, one real turn)
```

Every test is written to **skip cleanly when its precondition is absent** (no magpie binary, no root for :53, no running engine), so CI runs green on a bare runner. Add a case for every bug you fix, and make it fail before the fix.

## Style

- Comments explain **why**, not what. A comment that restates the code is noise; a comment that records the failure a line prevents is gold.
- Match the surrounding code. Plain ESM, no build step, no new runtime dependency unless there is no alternative.
- Keep the browser half dependency-free beyond the `react` the shell already provides.

## Submitting

Open a PR against `master` with a short description, the bug it fixes, and the test that proves it. Small and surgical beats large and sweeping.
