#!/usr/bin/env bash
# Runs one diagnostic command with process/resource capture. The command's own
# exit status is the step's status: captured, reported, never swallowed, and a
# cancellation (INT/TERM) also exits nonzero.
#
# ps is recorded WITHOUT the args column: artifacts of a public repo are
# downloadable and command lines can carry tokens, passwords or test auth
# values. The tree stays reconstructable from pid/ppid/comm.
#
# /usr/bin/time -v wraps the launcher, so its numbers are aggregate for the
# whole process tree; launcher_shell_pid below is the root for matching ps rows.
# SIGKILL (e.g. a runner-side timeout kill) bypasses every trap here: in that
# case no cleanup or post-capture is promised and the step is failed by the
# runner anyway.
set -u
name="$1"; shift
[ "${1:-}" = "--" ] && shift
mkdir -p diag
{
  echo "scenario=$name"
  echo "start=$(date -u +%FT%T.%3NZ)"
  echo "launcher_shell_pid=$$"
} | tee "diag/${name}-meta.txt"

( while true; do { echo "== $(date -u +%H:%M:%S.%3N) =="; ps -eo pid,ppid,comm,%cpu,%mem,rss,stat,etime --no-headers; } >> diag/ps.log 2>&1; sleep 2; done ) &
sampler=$!
echo "sampler_pid=$sampler" >> "diag/${name}-meta.txt"

post_capture() {
  {
    echo "== captured after command end: $(date -u +%H:%M:%S.%3N) =="
    echo "== free -m =="; free -m
    echo "== cgroup memory =="
    for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/events; do
      [ -r "$f" ] && { echo "$f:"; cat "$f"; }
    done
    echo "== dmesg tail =="; dmesg 2>&1 | tail -10 || echo "dmesg unavailable"
  } > "diag/${name}-post.txt" 2>&1
}

finalize() {
  rc=$?
  trap - EXIT INT TERM
  kill "$sampler" 2>/dev/null
  wait "$sampler" 2>/dev/null
  post_capture
  {
    echo "end=$(date -u +%FT%T.%3NZ)"
    echo "command_exit=$rc"
  } >> "diag/${name}-meta.txt"
  {
    echo "command_exit=$rc"
    echo "note: 139 is the shell convention for termination by signal 11; which"
    echo "process took the signal and why is NOT established by this number alone,"
    echo "and memory pressure can precede a segfault."
  } >> "diag/${name}.log"
  echo "command_exit=$rc"
  exit "$rc"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -x /usr/bin/time ]; then
  timewrap() { /usr/bin/time -v "$@"; }
else
  echo "note: /usr/bin/time unavailable on this runner; the -v resource summary is skipped (this is NOT a CLI/turbo result)" | tee -a "diag/${name}-meta.txt"
  timewrap() { "$@"; }
fi

set -o pipefail
timewrap "$@" 2>&1 | tee "diag/${name}.log"
exit "${PIPESTATUS[0]}"
