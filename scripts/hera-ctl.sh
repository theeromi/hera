#!/usr/bin/env bash
###############################################################################
#  hera-ctl — start / stop / restart HERA (dev mode)
#
#  Runs the backend (npm run dev) and the frontend (static server) as
#  background processes, tracks their PIDs, and gives you simple control.
#
#  Usage:
#     ./hera-ctl.sh start      start backend + frontend
#     ./hera-ctl.sh stop       stop both
#     ./hera-ctl.sh restart    stop then start
#     ./hera-ctl.sh status     show what's running
#     ./hera-ctl.sh logs       tail the backend log (Ctrl+C to exit)
###############################################################################
set -uo pipefail

# ── where things live (adjust if your paths differ) ─────────────────────────
HERA_DIR="${HERA_DIR:-$HOME/hera}"
BACKEND_DIR="$HERA_DIR/backend"
FRONTEND_DIR="$HERA_DIR/frontend"
FRONTEND_PORT="${FRONTEND_PORT:-8080}"

RUN_DIR="$HERA_DIR/.run"
BACKEND_PID="$RUN_DIR/backend.pid"
FRONTEND_PID="$RUN_DIR/frontend.pid"
BACKEND_LOG="$RUN_DIR/backend.log"
FRONTEND_LOG="$RUN_DIR/frontend.log"

# ── colors ──────────────────────────────────────────────────────────────────
A='\033[38;5;215m'; G='\033[38;5;114m'; R='\033[38;5;203m'; D='\033[38;5;245m'; N='\033[0m'
say(){ echo -e "${A}[hera]${N} $*"; }
ok(){  echo -e "  ${G}●${N} $*"; }
off(){ echo -e "  ${R}○${N} $*"; }
dim(){ echo -e "  ${D}$*${N}"; }

mkdir -p "$RUN_DIR"

is_running(){ [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

start_backend(){
  if is_running "$BACKEND_PID"; then ok "backend already running (pid $(cat "$BACKEND_PID"))"; return; fi
  # free port 8787 first — kill any orphan the script doesn't track
  local squatter
  squatter="$(lsof -ti :8787 2>/dev/null)"
  if [[ -n "$squatter" ]]; then
    dim "port 8787 was busy — clearing it"
    kill $squatter 2>/dev/null; sleep 1; kill -9 $squatter 2>/dev/null || true
  fi
  say "starting backend…"
  ( cd "$BACKEND_DIR" && npm run dev >"$BACKEND_LOG" 2>&1 & echo $! >"$BACKEND_PID" )
  sleep 2
  if is_running "$BACKEND_PID"; then ok "backend up (pid $(cat "$BACKEND_PID")) · http://localhost:8787";
  else off "backend failed to start — check: ./hera-ctl.sh logs"; fi
}

start_frontend(){
  if is_running "$FRONTEND_PID"; then ok "frontend already running (pid $(cat "$FRONTEND_PID"))"; return; fi
  # free the port first — kill any orphan server the script doesn't track
  local squatter
  squatter="$(lsof -ti :"$FRONTEND_PORT" 2>/dev/null)"
  if [[ -n "$squatter" ]]; then
    dim "port $FRONTEND_PORT was busy — clearing it"
    kill $squatter 2>/dev/null; sleep 1; kill -9 $squatter 2>/dev/null || true
  fi
  say "starting frontend…"
  ( cd "$FRONTEND_DIR" && python3 -m http.server "$FRONTEND_PORT" >"$FRONTEND_LOG" 2>&1 & echo $! >"$FRONTEND_PID" )
  sleep 1
  if is_running "$FRONTEND_PID"; then ok "frontend up (pid $(cat "$FRONTEND_PID")) · http://localhost:$FRONTEND_PORT";
  else off "frontend failed to start — check: cat $FRONTEND_LOG"; fi
}

stop_one(){
  local pidfile="$1" name="$2"
  if is_running "$pidfile"; then
    kill "$(cat "$pidfile")" 2>/dev/null
    sleep 1
    kill -9 "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile"
    off "$name stopped"
  else
    dim "$name not running"
    rm -f "$pidfile"
  fi
}

case "${1:-}" in
  start)
    start_backend; start_frontend
    say "HERA is up. open http://localhost:$FRONTEND_PORT"
    ;;
  stop)
    stop_one "$FRONTEND_PID" "frontend"
    stop_one "$BACKEND_PID"  "backend"
    ;;
  restart)
    stop_one "$FRONTEND_PID" "frontend"
    stop_one "$BACKEND_PID"  "backend"
    sleep 1
    start_backend; start_frontend
    say "HERA restarted."
    ;;
  status)
    say "HERA status:"
    is_running "$BACKEND_PID"  && ok "backend  · pid $(cat "$BACKEND_PID")  · :8787" || off "backend  · stopped"
    is_running "$FRONTEND_PID" && ok "frontend · pid $(cat "$FRONTEND_PID") · :$FRONTEND_PORT" || off "frontend · stopped"
    ;;
  logs)
    say "backend log (Ctrl+C to exit):"; tail -f "$BACKEND_LOG"
    ;;
  *)
    echo "usage: ./hera-ctl.sh {start|stop|restart|status|logs}"
    ;;
esac