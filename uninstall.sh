#!/bin/sh
# dsh-magpie-model uninstaller.
#
#   curl -fsSL https://gcore.jsdelivr.net/gh/ZRN-531/dsh-magpie-model@master/uninstall.sh | sh
#   ... | sh -s -- --purge      # also delete this plugin's settings & usage data
#
# What it removes (this plugin's registration and its own files):
#   - the bundle from the profile's dsh.profile.bundles
#   - the "dsh-magpie-model" dependency from the profile's package.json
#   - the node_modules/dsh-magpie-model symlink
#   - the plugin source at $DSH_HOME/plugins/dsh-magpie-model
#   - with --purge: the plugin's own data dir $DSH_HOME/magpie-model
#     (settings + usage). magpie's ACCOUNTS and its BINARY are never touched.
#
# What it deliberately does NOT remove:
#   - the magpie binary ($DSH_HOME/.local/bin/magpie) — other tools may use it
#   - magpie's accounts/config ($DSH_HOME/.config/magpie) — that is your sign-in data
#     You can delete those by hand if you are sure nothing else needs them.
#
# Restart the dsh engine afterwards (Settings → Restart engine) to unload it.
set -eu

say() { printf '  %s\n' "$*"; }
die() { printf 'magpie-model: %s\n' "$*" >&2; exit 1; }

PURGE=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -y|--yes) : ;;  # accepted for symmetry; nothing is destructive enough to prompt
    -h|--help) echo "usage: uninstall.sh [--purge]"; exit 0 ;;
    *) die "unknown option $a (try --purge or --help)" ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
DSH_DIR="$DSH_HOME/profiles/$PROFILE"
NAME="dsh-magpie-model"
PLUGIN_DIR="$DSH_HOME/plugins/$NAME"
DATA_DIR="$DSH_HOME/magpie-model"

[ -d "$DSH_HOME" ] || die "no dsh home at $DSH_HOME (set DSH_HOME)"
say "dsh home : $DSH_HOME"
say "profile  : $PROFILE"

# ── 1. profile registration: drop the bundle, the dependency, the symlink ────
PKG="$DSH_DIR/package.json"
if [ -f "$PKG" ]; then
  node - "$PKG" "$NAME" <<'NODE'
const fs = require('fs'), path = require('path')
const [pkgPath, NAME] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
let changed = false
if (pkg.dependencies && Object.hasOwn(pkg.dependencies, NAME)) { delete pkg.dependencies[NAME]; changed = true }
const bundles = pkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = bundles.filter(b => b !== NAME)
  if (next.length !== bundles.length) { pkg.dsh.profile.bundles = next; changed = true }
}
if (changed) {
  const backup = `${pkgPath}.bak-${Date.now()}`
  fs.copyFileSync(pkgPath, backup)
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  console.log(`  removed ${NAME} from ${pkgPath} (backup: ${path.basename(backup)})`)
} else {
  console.log(`  ${NAME} was not registered in ${pkgPath} (nothing to remove)`)
}
NODE
else
  say "no profile manifest at $PKG — skipping registration cleanup"
fi

LINK="$DSH_DIR/node_modules/$NAME"
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  rm -rf "$LINK" && say "removed symlink $LINK"
else
  say "no symlink at $LINK (already gone)"
fi

# ── 2. plugin source ─────────────────────────────────────────────────────────
if [ -d "$PLUGIN_DIR" ]; then
  rm -rf "$PLUGIN_DIR" && say "removed plugin source $PLUGIN_DIR"
else
  say "no plugin source at $PLUGIN_DIR (already gone)"
fi

# ── 3. optional: this plugin's own data (settings + usage) ───────────────────
if [ "$PURGE" = "1" ]; then
  if [ -d "$DATA_DIR" ]; then
    rm -rf "$DATA_DIR" && say "purged plugin data $DATA_DIR (settings + usage)"
  else
    say "no plugin data at $DATA_DIR"
  fi
else
  [ -d "$DATA_DIR" ] && say "kept plugin data at $DATA_DIR (re-run with --purge to delete it)"
fi

# ── never touched — say so, so the user is not surprised ─────────────────────
say "left untouched: magpie binary (\$DSH_HOME/.local/bin/magpie) and magpie accounts (\$DSH_HOME/.config/magpie)"
printf '\n'
say "Done. Restart the dsh engine (Settings → Restart engine) to unload the plugin."
say "To also remove magpie itself later: delete \$DSH_HOME/.local/bin/magpie and \$DSH_HOME/.config/magpie."
