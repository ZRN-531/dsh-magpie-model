# dsh-magpie-model

> 中文文档见 [README.md](README.md).

Bring [magpie](https://usemagpie.ai)'s local gateway into the [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) model picker.

magpie collects every agent's skills in one place; this plugin turns its local gateway into a dsh provider route. The plugin starts and supervises `magpie serve`, supplies the local DNS resolution a pure-Go magpie cannot get on Android, syncs the gateway's model catalog (thinking levels and context windows included), and translates the OpenAI-compatible stream onto the harness's event contract.

**No API key is configured in dsh** — magpie's own account channels hold the credentials. This plugin drives magpie's gateway and never sees a key.

## Why a plugin instead of just using magpie

magpie ships a *handover* feature: when it detects the host agent (it knows dsh internally as PenguinHarness), it writes itself into the agent's model config as a provider literally named `magpie` (via `dsh-llm-pi-ai`). That is fine on a desktop, but on a **mobile / terminal-less** host there is no one to manage magpie's binary, gateway process, or DNS — which is exactly what this plugin does. It also **disables handover** (`MAGPIE_NO_HANDOVER=1`) and uses its own provider route name `magpie-model`, so it never fights the provider handover injects (a name collision there fails pi-ai's whole fiber and degrades the profile — see "Pitfalls" below).

## Features

- **Supervised gateway** — spawns `magpie serve`, probes it with `magpie healthcheck`, restarts it with backoff. If a gateway is already running (the user's own `magpie web`, or a leftover from a previous engine generation), it is **adopted**, not duplicated.
- **Local DNS forwarder** (required on Android) — magpie is a pure-Go binary that reads `/etc/resolv.conf`, which does not exist on Android (`/etc` points at a read-only `/system/etc`). The plugin runs a UDP forwarder on port 53 that hands queries to public resolvers.
- **Catalog sync** — pulls `/v1/models`, maps to dsh modelInfo (context window, max output, thinking levels, vision). Periodic and on demand.
- **Thinking levels that actually work** — maps the harness `off` to the wire `none`; the rest pass through unchanged on `reasoning_effort`. Measured: `off` → 0 reasoning tokens, `xhigh` → tens.
- **Automatic failover** — if a model fails (empty response / dropped connection) **before emitting any output**, retry on the next available model. Never duplicates output; a user cancellation or a 4xx is not switched; the model that actually answered is reported.
- **Model pin / hide / order** — keep the picker to the one or two of six models you use, pinned to the top; local only, zero cost.
- **Multiplier & price** — each model shows magpie's own **multiplier** (`rate`) and real list price (`$input/$output per 1M tokens`); free models are badged. **Shown inline after the model name in the picker** (e.g. `DeepSeek-V4-Pro · x0.51`, `Hy3 · 免费`), with the full price in the settings table. Read from magpie's web API `/api/providers` (the same data its channel page shows), not computed by the plugin.
- **Glass settings page** — gateway/DNS status, per-model test, usage dashboard (by model / daily curve), switches that take effect on save (the gateway restarts automatically; no engine restart).
- **Works out of the box** — `serveWeb` is on by default; open `http://127.0.0.1:3430/?k=<key>` to sign in more magpie account channels.

## Install

**One line (recommended — this is what you share with a friend):**

```sh
# primary (jsDelivr CDN):
curl -fsSL https://gcore.jsdelivr.net/gh/ZRN-531/dsh-magpie-model@master/install.sh | sh

# if that cannot fetch the script, use the GitHub proxy:
# curl -fsSL https://ghproxy.net/https://raw.githubusercontent.com/ZRN-531/dsh-magpie-model/master/install.sh | sh
```

It (1) installs the magpie binary to `$DSH_HOME/.local/bin` (survives engine updates), (2) puts the plugin source at `$DSH_HOME/plugins/dsh-magpie-model`, and (3) registers it in your dsh profile (writes `dependencies` + `dsh.profile.bundles`, makes the `node_modules` symlink). Then **restart the dsh engine** — a **Magpie** group appears in the model picker.

> **Prerequisite**: dsh Mobile must already be installed and started once (so `~/.dsh` and the `web` profile exist). magpie accounts (models and credentials) are not shipped with the plugin — sign in to your own channels from the plugin's settings page → *web console*.
>
> Knobs (env): `DSH_HOME` / `DSH_PROFILE` (default `~/.dsh`, `web`), `MAGPIE_SKIP=1` (you manage the magpie binary yourself), `MAGPIE_MIRROR=` (a mirror for a restricted network). The magpie binary is ~60 MB; direct GitHub download is usually 1–2 min.

`package.json` declares `dsh.bundle.patch` (host half) and `dsh.client` (browser half).

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Off hides every model and refuses every call; the gateway stops too |
| `dns` | `true` | Local DNS forwarder switch |
| `serveWeb` | `true` | Serve magpie's web console from the same process |
| `addr` | `''` (→ `127.0.0.1:3425`) | Gateway address; `MAGPIE_ADDR` env wins |
| `webAddr` | `''` (→ `127.0.0.1:3430`) | Page address |
| `webKey` | `''` (random key minted on first boot) | Page key; magpie wants 16+ chars from `[A-Za-z0-9-._~]`; unique per install |
| `refreshMinutes` | `10` | Catalog refresh interval; 0 = off |
| `updateHours` | `6` | magpie update-check interval (hours); 0 = only at startup |
| `autoFallback` | `true` | If a model fails (empty/dropped) **before emitting any output**, retry on the next model (never duplicates output; cancellations and 4xx are not switched) |
| `fallbackChain` | `[]` | Explicit fallback order (model ids); empty = every other non-group model, catalog order |
| `visibleModels` | `[]` | Which models the picker shows, and their order; empty = all, non-empty = only these in this order |

Fields pinned by a bundle patch render disabled in the page and are refused with `409` — a patch value is an in-memory overlay, never written into the persisted settings file.

## Development & tests

```sh
node test/client-lint.mjs     # browser half: evaluates the ModuleLoader bundle, renders every card, checks zh/en key parity
node test/integration.mjs     # mock-kernel integration + (when magpie is installed) real gateway turns
node test/verify-live.mjs     # live end-to-end against a running dsh (token handshake, status, models, one real turn)
```

Every test skips cleanly when its precondition is absent (no magpie binary, no root for :53, no running engine), so CI is green on a bare runner. Add a case for every bug you fix.

## Uninstall

```sh
# plain: removes the plugin registration + source; keeps the magpie binary, your
# accounts, and the plugin's own settings/usage data
curl -fsSL https://gcore.jsdelivr.net/gh/ZRN-531/dsh-magpie-model@master/uninstall.sh | sh

# also delete the plugin's settings/usage data (magpie binary and accounts still kept)
# curl -fsSL https://gcore.jsdelivr.net/gh/ZRN-531/dsh-magpie-model@master/uninstall.sh | sh -s -- --purge
```

Uninstall **always keeps** the magpie binary (`$DSH_HOME/.local/bin/magpie`) and magpie accounts (`$DSH_HOME/.config/magpie`) — they may be shared and the accounts are your sign-in data; delete those by hand only if you are sure. Restart the engine afterwards.

## Self-check & repair: `doctor`

A dsh Mobile app update reinstalls the engine directory but keeps user data under `$DSH_HOME`. Everything this plugin needs (source, magpie binary, accounts, settings, profile registration) lives under `$DSH_HOME`, so an update normally leaves it working. But two failures are **silent** — the plugin simply does not load and the picker shows no Magpie group, with the only evidence in the engine log:

1. the profile's `dsh.profile.bundles` no longer lists `dsh-magpie-model` (a template rewrite during a major upgrade);
2. the profile's `node_modules/dsh-magpie-model` symlink is gone or dangling (node_modules rebuilt, or an offline install that failed).

`doctor` checks both (plus source, binary, accounts, and liveness), repairs them **in place** (backing up before writing, idempotent), and runs a live check to prove the plugin is actually serving:

```sh
node scripts/doctor.mjs            # check + repair + live check (one real round trip)
node scripts/doctor.mjs --check    # check only; change nothing
node scripts/doctor.mjs --no-live  # skip the live check (local only, ~180ms, free)
node scripts/doctor.mjs --json     # machine-readable summary
```

> Run `node scripts/doctor.mjs` **after an app update**. For a quick reassurance **any time**, `--no-live --check` (~180ms, no network, no inference, no cost) catches both silent failures above.

## Pitfalls (all fixed here, each with a regression lock)

1. **A colliding provider route name degraded the whole profile.** The route was first the bare `magpie`, the same name magpie's handover injects into `dsh-llm-pi-ai` → `LlmError: configurable provider "magpie" is already declared` → pi-ai's fiber failed, profile degraded, the default model went down with it. Fixed: route is `magpie-model` + `MAGPIE_NO_HANDOVER=1`.
2. **The binary was installed into the engine dir and wiped by an engine update.** `curl … | sh` defaults to `$PREFIX/bin`, which the engine clears on update. Fixed: install to `~/.local/bin`; `locateMagpie` probes there first.
3. **A pure-Go magpie resolves nothing on Android.** No `/etc/resolv.conf`; Go falls back to `[::1]:53`, refused. Fixed: a local :53 forwarder.
4. **A bundle-patch config was persisted and poisoned user settings.** A test mount with `{enabled:false}` wrote to the real settings file, so the engine next booted switched off. Fixed: the patch is an in-memory overlay; pinned fields are rejected (409).
5. **A failed :53 bind hung startup forever.** The failure arrives on the socket `error` event; the handler recorded it but never settled the promise, so `await bind()` hung. "Degrades when not root" was a hang. Fixed: settle on error + a 5s bind timeout.
6. **Hot reload leaked the :53 listener.** A fiber torn down mid-bind orphaned the socket. Fixed: a post-await `disposed` check.
7. **Thinking models truncated answers under a small max_tokens.** Reasoning tokens count against the budget. Made the test deterministic with `effort off`, which also proved effort really reaches the model.
8. **A user cancellation must report `aborted`, not a retryable TRANSPORT**, or the kernel retries a turn the user stopped.

## License

MIT
