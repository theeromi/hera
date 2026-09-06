#!/usr/bin/env bash
###############################################################################
#  HERA — host setup helper
#
#  Run this ON THE HERA HOST (the Pi). It will:
#    1. Create HERA's dedicated SSH key (once, if it doesn't exist)
#    2. Copy that key to each host you want HERA to read
#    3. Test the connection and show you what HERA can see
#
#  Usage:
#     ./hera-setup-host.sh                    → interactive, asks for details
#     ./hera-setup-host.sh user@192.168.1.187 → set up one host directly
#     ./hera-setup-host.sh --test-all         → re-test every configured host
#
#  Safe to re-run. It never overwrites an existing key and only ever runs
#  READ-ONLY commands on the target machines.
###############################################################################
set -uo pipefail

KEY="${HERA_KEY:-$HOME/.ssh/hera_key}"
HOSTS_FILE="${HERA_HOSTS_FILE:-$HOME/.hera-hosts}"

# ── pretty output ────────────────────────────────────────────────────────────
A='\033[38;5;215m'; G='\033[38;5;114m'; R='\033[38;5;203m'; D='\033[38;5;245m'; N='\033[0m'
say()  { echo -e "${A}[hera]${N} $*"; }
ok()   { echo -e "  ${G}ok${N}   $*"; }
bad()  { echo -e "  ${R}fail${N} $*"; }
dim()  { echo -e "  ${D}$*${N}"; }

banner() {
cat <<'EOF'

  ██╗  ██╗███████╗██████╗  █████╗
  ██║  ██║██╔════╝██╔══██╗██╔══██╗
  ███████║█████╗  ██████╔╝███████║
  ██╔══██║██╔══╝  ██╔══██╗██╔══██║
  ██║  ██║███████╗██║  ██║██║  ██║
  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝
  host setup — give HERA eyes on your homelab

EOF
}

# ── 1. make sure HERA has a key ──────────────────────────────────────────────
ensure_key() {
  if [[ -f "$KEY" ]]; then
    ok "HERA key already exists at $KEY"
  else
    say "creating HERA's SSH key (no passphrase — HERA logs in unattended)"
    ssh-keygen -t ed25519 -f "$KEY" -N "" -C "hera@$(hostname)" >/dev/null
    ok "created $KEY"
  fi
  chmod 600 "$KEY" 2>/dev/null
  chmod 644 "$KEY.pub" 2>/dev/null
}

# ── helper: split "user@host:port" into target + port ────────────────────────
# accepts:  user@ip          → port 22
#           user@ip:9222     → port 9222
parse_target() {
  local raw="$1"
  if [[ "$raw" == *:* ]]; then
    TARGET="${raw%:*}"
    PORT="${raw##*:}"
  else
    TARGET="$raw"
    PORT="22"
  fi
}

# ── 2. authorize the key on a target host ────────────────────────────────────
add_host() {
  local raw="$1"          # user@ip  or  user@ip:port
  parse_target "$raw"
  say "setting up ${A}${TARGET}${N} (port ${PORT})"

  if ssh -i "$KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=5 "$TARGET" true 2>/dev/null; then
    ok "key already authorized (no password needed)"
  else
    dim "copying HERA's public key — you'll be asked for this host's password once"
    if ! ssh-copy-id -i "$KEY.pub" -p "$PORT" "$TARGET" >/dev/null 2>&1; then
      bad "could not copy the key to $TARGET:$PORT"
      dim "check: is SSH enabled on that box? is the user/IP/port right?"
      return 1
    fi
    ok "key installed"
  fi

  test_host "$raw" || return 1

  # remember it for --test-all
  touch "$HOSTS_FILE"
  grep -qxF "$raw" "$HOSTS_FILE" || echo "$raw" >> "$HOSTS_FILE"
  return 0
}

# ── 3. test what HERA can read (READ-ONLY commands only) ─────────────────────
test_host() {
  local raw="$1"
  parse_target "$raw"
  local out

  out=$(ssh -i "$KEY" -p "$PORT" -o BatchMode=yes -o ConnectTimeout=8 "$TARGET" \
        "hostname; echo '---'; uptime -p 2>/dev/null || uptime; echo '---'; \
         df -h --output=source,size,used,avail,pcent 2>/dev/null | grep -vE 'tmpfs|overlay|udev|efivarfs' | tail -n +2; \
         echo '---'; (docker ps --format '{{.Names}}' 2>/dev/null || echo 'no docker')" 2>/dev/null)

  if [[ -z "$out" ]]; then
    bad "connected, but could not read anything from $TARGET"
    return 1
  fi

  local host up disks dockers
  host=$(sed -n '1p' <<<"$out")
  up=$(awk '/^---$/{n++;next} n==1' <<<"$out" | head -1)
  disks=$(awk '/^---$/{n++;next} n==2' <<<"$out")
  dockers=$(awk '/^---$/{n++;next} n==3' <<<"$out")

  ok "connected to ${A}${host}${N}"
  [[ -n "$up" ]] && dim "uptime:  $up"
  if [[ -n "$disks" ]]; then
    dim "storage:"
    while IFS= read -r l; do [[ -n "$l" ]] && dim "   $l"; done <<<"$disks"
  fi
  if [[ "$dockers" == "no docker" || -z "$dockers" ]]; then
    dim "docker:  none detected"
  else
    dim "docker:  $(wc -l <<<"$dockers") container(s) — $(tr '\n' ' ' <<<"$dockers")"
  fi
  echo
  return 0
}

# ── 4. modes ─────────────────────────────────────────────────────────────────
test_all() {
  [[ -f "$HOSTS_FILE" ]] || { bad "no hosts configured yet — run without --test-all first"; exit 1; }
  say "re-testing every configured host"; echo
  local fails=0
  # read from FD 3 so ssh inside the loop can't swallow the host list on stdin
  while IFS= read -r h <&3; do
    [[ -n "$h" ]] && { test_host "$h" </dev/null || ((fails++)); }
  done 3< "$HOSTS_FILE"
  [[ $fails -eq 0 ]] && say "all hosts reachable ✓" || say "$fails host(s) had problems"
}

interactive() {
  say "add the machines you want HERA to read."
  dim "format: user@ip        (e.g. dimandem@192.168.1.187)"
  dim "        user@ip:port   (e.g. Dimandem@192.168.1.197:9222 for a custom SSH port)"
  dim "press Enter on an empty line when you're done"
  echo
  while true; do
    read -rp "  host > " target
    [[ -z "$target" ]] && break
    [[ "$target" != *"@"* ]] && { bad "use the form user@ip or user@ip:port"; continue; }
    add_host "$target" </dev/null
  done
}

# ── main ─────────────────────────────────────────────────────────────────────
banner
ensure_key
echo

case "${1:-}" in
  --test-all) test_all ;;
  "")         interactive ;;
  *)          add_host "$1" ;;
esac

echo
say "HERA's key: ${A}${KEY}${N}"
say "configured hosts: ${A}${HOSTS_FILE}${N}"
dim "point HERA at these hosts in Settings → Integrations"
