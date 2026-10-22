#!/usr/bin/python3
# Skickar botens Hermes-anrop till agenterna på Dator 2 över Tailscale (SSH).
#
# Används via HERMES_BIN i .env. Boten startar detta skript precis som den
# startar hermes: samma argument, svaret på stdout, samma exitkod.
# Argumenten skickas som JSON på stdin (inte på kommandoraden), så långa
# prompter och specialtecken aldrig tolkas av något skal.
# --usage-file skrivs på Dator 2 och hämtas tillbaka hit efter körningen.
import json
import os
import subprocess
import sys

FJARR = os.environ.get("HERMES_REMOTE_HOST", "mikaeljohansson@aiupscale-dator2.tail64d627.ts.net")
FJARR_HERMES = "/Users/mikaeljohansson/.local/bin/hermes"
SSH = ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", FJARR]

# Körs på Dator 2: läser argumenten, kör hermes i en tom tillfällig mapp,
# skriver svaret på stdout och usage-filens innehåll efter en avgränsare på stderr.
FJARR_SKRIPT = r"""
import json, os, subprocess, sys, tempfile, shutil
d = json.load(sys.stdin)
args = d["args"]
tmp = tempfile.mkdtemp(prefix="hermes-dator1-")
usage = None
try:
    if d["usage_index"] is not None:
        usage = os.path.join(tmp, "usage.json")
        args[d["usage_index"]] = usage
    r = subprocess.run([d["bin"]] + args, cwd=tmp, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    if usage and os.path.exists(usage):
        sys.stderr.write("\n@@HERMES_USAGE@@" + open(usage).read())
    sys.exit(r.returncode)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
"""

AVGRANSARE = "\n@@HERMES_USAGE@@"


def main() -> int:
    args = sys.argv[1:]
    lokal_usage = None
    usage_index = None
    if "--usage-file" in args:
        i = args.index("--usage-file")
        if i + 1 < len(args):
            usage_index = i + 1
            lokal_usage = args[i + 1]
    data = json.dumps({"bin": FJARR_HERMES, "args": args, "usage_index": usage_index})
    try:
        # Skriptet skickas som första rad på stdin, argumenten som andra rad
        payload = json.dumps(FJARR_SKRIPT) + "\n" + data + "\n"
        r = subprocess.run(
            SSH + ["/usr/bin/python3", "-c",
                   "'import json,sys,io; s=json.loads(sys.stdin.readline()); sys.stdin=io.StringIO(sys.stdin.readline()); exec(s)'"],
            input=payload, capture_output=True, text=True)
    except Exception as e:
        sys.stderr.write(f"hermes-dator2: kunde inte nå Dator 2: {e}\n")
        return 3
    fel = r.stderr
    if AVGRANSARE in fel:
        fel, usage_text = fel.split(AVGRANSARE, 1)
        if lokal_usage:
            try:
                with open(lokal_usage, "w", encoding="utf-8") as f:
                    f.write(usage_text)
            except OSError as e:
                fel += f"\nhermes-dator2: kunde inte skriva usage-filen: {e}"
    sys.stdout.write(r.stdout)
    sys.stderr.write(fel)
    # 255 = SSH-fel (Dator 2 nås inte) — rapporteras som transportfel av boten
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
