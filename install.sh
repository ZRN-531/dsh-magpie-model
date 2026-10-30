#!/bin/sh
# dsh-magpie-model one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ZRN-531/dsh-magpie-model/master/install.sh | sh
#
# Installs three things, because the plugin on its own is useless without them:
#   1. the magpie binary → $DSH_HOME/.local/bin (survives engine updates)
#   2. the plugin source → $DSH_HOME/plugins/dsh-magpie-model
#   3. a profile registration (dependencies + dsh.profile.bundles) + a symlink
#      in node_modules, so dsh loads it on the next engine start.
#
# It does NOT touch magpie's accounts: your models and credentials are yours, and
# you sign them in yourself (the plugin only drives the gateway).
#
# Overrides (env): DSH_HOME, DSH_PROFILE, MAGPIE_TARBALL_URL, PLUGIN_TARBALL_URL,
# MAGPIE_MIRROR, MAGPIE_SKIP=1 (do not install the binary — you manage magpie
# yourself), SKIP_ENGINE_RESTART (never restart; just print the instruction).
set -eu

say() { printf '  %s\n' "$*"; }
die() { printf 'magpie-model: %s\n' "$*" >&2; exit 1; }

# ── where things live ────────────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
DSH_DIR="$DSH_HOME/profiles/$PROFILE"
PLUGIN_DIR="$DSH_HOME/plugins/dsh-magpie-model"
BIN_DIR="$DSH_HOME/.local/bin"
REPO="${MAGPIE_MODEL_REPO:-ZRN-531/dsh-magpie-model}"

[ -d "$DSH_HOME" ] || die "no dsh home at $DSH_HOME — is dsh Mobile installed and has it run once? (set DSH_HOME to override)"
[ -f "$DSH_DIR/package.json" ] || die "no profile at $DSH_DIR — start dsh once (so the '$PROFILE' profile exists), or set DSH_PROFILE"

say "dsh home : $DSH_HOME"
say "profile  : $PROFILE"

# ── a temp dir + cleanup ─────────────────────────────────────────────────────
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t mgp)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# ── 1. magpie binary (persistent location) ───────────────────────────────────
MAGPIE_BIN="$BIN_DIR/magpie"
if [ "${MAGPIE_SKIP:-0}" = "1" ]; then
  say "skipping the magpie binary (MAGPIE_SKIP=1); expecting it on your PATH or \$MAGPIE_BIN"
elif [ -x "$MAGPIE_BIN" ]; then
  say "magpie already present: $MAGPIE_BIN ($("$MAGPIE_BIN" --version 2>/dev/null | head -1))"
else
  say "installing magpie → $MAGPIE_BIN"
  mkdir -p "$BIN_DIR"
  command -v curl >/dev/null 2>&1 || die "curl is required to download magpie"
  # GitHub's release CDN is walled on many mobile networks, and no single mirror
  # is dependable. Try the official installer over a list of mirrors (it verifies
  # the release checksum itself), then the direct URL, stopping at the first that
  # works. An empty mirror means "no mirror".
  installed=0
  # Direct first: on the networks seen here the GitHub release CDN is actually the
  # fast path (~0.8 MB/s, ~70s for 60 MB) while the public mirrors throttle hard
  # (~0.1 MB/s). Mirrors are only fallbacks for a network where github.com itself
  # is walled. Each attempt is time-boxed so one dead path cannot hang the install.
  for m in "${MAGPIE_MIRROR:-}" "" "https://ghproxy.net/" "https://gh-proxy.com/"; do
    say "  via ${m:-direct github} …"
    if timeout 300 env TERMUX_VERSION="${TERMUX_VERSION:-1}" MAGPIE_BIN_DIR="$BIN_DIR" MAGPIE_MIRROR="$m" \
        sh -c "$(curl -fsSL https://usemagpie.ai/install.sh)" >/dev/null 2>&1 && [ -x "$MAGPIE_BIN" ]; then
      installed=1; break
    fi
    say "    (that path did not finish; trying the next)"
  done
  [ "$installed" = "1" ] || die "could not install magpie through any mirror — install it yourself (https://usemagpie.ai), put the binary at $MAGPIE_BIN or on PATH, then re-run with MAGPIE_SKIP=1"
  say "magpie installed: $("$MAGPIE_BIN" --version 2>/dev/null | head -1)"
fi

# ── 2. plugin source ─────────────────────────────────────────────────────────
say "downloading plugin → $PLUGIN_DIR"
rm -rf "$PLUGIN_DIR"; mkdir -p "$PLUGIN_DIR"
if [ -n "${PLUGIN_TARBALL_URL:-}" ]; then
  url="$PLUGIN_TARBALL_URL"
  command -v curl >/dev/null 2>&1 || die "curl is required to download the plugin"
  curl -fsSL "$url" -o "$TMP/plugin.tar.gz" || die "download failed: $url"
else
  url="https://github.com/$REPO/archive/refs/heads/master.tar.gz"
  command -v curl >/dev/null 2>&1 || die "curl is required to download the plugin"
  # codeload (github.com archive) is often reachable even when the release CDN is
  # not; try the direct archive first, then a mirror.
  curl -fsSL "$url" -o "$TMP/plugin.tar.gz" || curl -fsSL "https://ghproxy.net/$url" -o "$TMP/plugin.tar.gz" || die "download failed: $url"
fi
tar -xzf "$TMP/plugin.tar.gz" -C "$PLUGIN_DIR" --strip-components=1 || die "could not unpack the plugin archive"
[ -f "$PLUGIN_DIR/package.json" ] || die "the plugin archive did not contain package.json"
node -e "process.exit(require('$PLUGIN_DIR/package.json').name==='dsh-magpie-model'?0:1)" 2>/dev/null || die "the archive is not dsh-magpie-model"
say "plugin source: $PLUGIN_DIR ($(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo '?'))"

# ── 3. profile registration: dependencies + bundles + node_modules symlink ────
node - "$DSH_DIR" "$PLUGIN_DIR" <<'NODE'
const fs = require('fs'), path = require('path')
const [profileDir, pluginDir] = process.argv.slice(2)
const pkgPath = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const NAME = 'dsh-magpie-model'
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[NAME] = `link:${path.relative(profileDir, pluginDir).split(path.sep).join('/')}`
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (!bundles.includes(NAME)) bundles.push(NAME)
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
// symlink so Node resolves the bundle without a package manager run
const linkPath = path.join(profileDir, 'node_modules', NAME)
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
try { fs.rmSync(linkPath, { recursive: true, force: true }) } catch {}
fs.symlinkSync(pluginDir, linkPath)
console.log(`  registered ${NAME} in ${pkgPath}`)
console.log(`  linked      ${linkPath} -> ${pluginDir}`)
NODE

say "done. plugin installed."
printf '\n'
say "Next: restart the dsh engine (Settings → Restart engine, or 设置 → 重启引擎)."
say "Then open a chat's model picker: a 'Magpie' group appears with your models."
say "No account yet? Open the plugin's settings page → '网页控制台' to sign magpie in."
