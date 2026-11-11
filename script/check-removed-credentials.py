#!/usr/bin/env python3
"""Check tracked files for removed credential fingerprints. Never print matching bytes."""
import hashlib
import pathlib
import re
import subprocess
import sys

FINGERPRINTS = [(35, '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60'), (43, '25bc9496dea6d110d9c59733f99839c95c2d926bd7b9929dc00834f371a706db')]
root = pathlib.Path(__file__).resolve().parent.parent
paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
failed = []
for name in filter(None, paths):
    path = root / name
    if not path.is_file():
        continue
    data = path.read_bytes()
    # Historical credentials were contiguous non-whitespace tokens. Include all
    # substrings of each token so embedded credentials are caught as well.
    found = False
    for token in re.finditer(rb"[A-Za-z0-9_!@#$%^&*()+=:/?.~-]+", data):
        value = token.group()
        for size, digest in FINGERPRINTS:
            if len(value) < size:
                continue
            for offset in range(len(value) - size + 1):
                if hashlib.sha256(value[offset:offset + size]).hexdigest() == digest:
                    found = True
                    break
            if found:
                break
        if found:
            break
    if found:
        failed.append(name)
if failed:
    print("FAIL: removed credential fingerprint present in tracked files:")
    print("\n".join(failed))
    sys.exit(1)
print("PASS: removed credential fingerprints absent from tracked files")
