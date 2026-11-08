#!/usr/bin/env bash
# Read-only environment evidence for the linux unit crash investigation.
# dmesg/journal may be denied on hosted runners: record that, never sudo.
# No core enabling: only the current limit/pattern are recorded.
set -u
mkdir -p diag
{
  echo "== git =="; git rev-parse HEAD
  echo "== runner =="
  echo "ImageOS=${ImageOS:-unknown} ImageVersion=${ImageVersion:-unknown} RUNNER_OS=${RUNNER_OS:-unknown} RUNNER_ARCH=${RUNNER_ARCH:-unknown}"
  echo "== uname =="; uname -a
  echo "== bun =="; bun --version; bun --revision 2>&1 || true
  echo "== turbo (local pinned binary; never bunx) =="
  ls -l node_modules/.bin/turbo 2>&1 || echo "node_modules/.bin/turbo missing"
  ./node_modules/.bin/turbo --version 2>&1 | head -2 || true
  grep -n '"turbo"' package.json || true
  echo "== node =="; node --version
  echo "== lockfile sha256 =="; sha256sum bun.lock 2>/dev/null || sha256sum bun.lockb 2>/dev/null || echo "no lockfile found"
  echo "== ulimit -c =="; ulimit -c
  echo "== core_pattern =="; cat /proc/sys/kernel/core_pattern 2>&1 || echo "unreadable"
  echo "== free -m =="; free -m
  echo "== cgroup memory =="
  for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory/events /sys/fs/cgroup/memory/memory.limit_in_bytes /sys/fs/cgroup/memory/memory.usage_in_bytes; do
    [ -r "$f" ] && echo "$f: $(cat "$f")"
  done
  echo "== dmesg tail =="; dmesg 2>&1 | tail -5 || echo "dmesg unavailable"
} > diag/evidence.txt 2>&1
cat diag/evidence.txt
