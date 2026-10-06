#!/usr/bin/env python3
"""Komplettera IG-inloggning lokalt. Hemligheter skickas aldrig till dashboarden."""
import argparse
import getpass
import json
import os
from pathlib import Path
import tempfile
import sys
import warnings


def configure(mode, filename):
    if not sys.stdin.isatty():
        raise ValueError("Kör konfigurationen i en interaktiv terminal; inmatning får inte eka")
    warnings.simplefilter("error", getpass.GetPassWarning)
    file = Path(filename).expanduser()
    if file.is_symlink():
        raise ValueError("Credentialsfilen får inte vara en symbolisk länk")
    existing = {}
    if file.exists():
        if file.stat().st_uid != os.getuid() or file.stat().st_mode & 0o077:
            raise ValueError("Credentialsfilen måste ägas av dig och ha rättighet 600")
        existing = json.loads(file.read_text())
        if not isinstance(existing, dict):
            raise ValueError("Credentialsfilen har ogiltigt format")
    modes = ["demo", "live"] if mode == "both" else [mode]
    for environment in modes:
        row = existing.get(environment, {})
        if not isinstance(row, dict):
            raise ValueError("Credentialsfilen har ogiltig miljö")
        print(f"IG {environment}: lämna tomt för att behålla befintligt värde.")
        for field, label in [("apiKey", "API-nyckel"), ("identifier", "IG identifier"), ("password", "IG lösenord")]:
            value = getpass.getpass(f"{label}: ")
            if value:
                row[field] = value.strip() if field != "password" else value
        if not all(isinstance(row.get(k), str) and row[k] for k in ["apiKey", "identifier", "password"]):
            raise ValueError("API-nyckel, identifier och lösenord krävs; ingen ändring sparades")
        existing[environment] = row
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if file.parent.is_symlink() or file.parent.stat().st_uid != os.getuid() or file.parent.stat().st_mode & 0o077:
        raise ValueError("Credentialskatalogen måste vara privat (700) och ägas av dig")
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".trading-ig-", dir=file.parent)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(existing, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    print("IG-credentials sparades lokalt med rättighet 600. Ingen inloggning eller order skickades.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["demo", "live", "both"], required=True)
    parser.add_argument("--file", default=os.environ.get("IG_CREDENTIALS_FILE", "~/.config/aiupscale/trading-ig.json"))
    args = parser.parse_args()
    try:
        configure(args.mode, args.file)
    except (OSError, ValueError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print("IG-konfiguration kunde inte sparas. Kontrollera format och filrättigheter; ingen hemlighet visas.")
        raise SystemExit(1)
