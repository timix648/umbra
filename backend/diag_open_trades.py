#!/usr/bin/env python3
"""Read-only: for every onboarded wallet party, how many trades sit at each stage.

A settlement that stalled on a counterparty's step shows up as a live SwapProposal
or RealSwapPending that nobody has moved on.

Python rather than shell on purpose: `wsl.exe -- bash -lc` reached through Git Bash
mangles a shell variable holding a `::` party id to the empty string.

    python3 diag_open_trades.py [api-base]
"""
import json
import sys
import urllib.parse
import urllib.request

API = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4200"


def get(path):
    with urllib.request.urlopen(API + path, timeout=60) as r:
        return json.load(r)


def main():
    wallets = [w["partyId"] for w in get("/api/ext/wallets")["wallets"]]
    print(f"{len(wallets)} onboarded wallet parties\n")
    for w in wallets:
        q = urllib.parse.quote(w, safe="")
        short = w.split("::")[0]
        try:
            pr = get("/api/swap/proposals?role=" + q)["count"]
            pe = get("/api/swap/pending-real?role=" + q)["count"]
            st = get("/api/swap/settlements?role=" + q)["count"]
            flag = "  <-- mid-settlement" if (pr or pe or st) else ""
            print(f"{short:24s} proposals={pr} pendingReal={pe} settlements={st}{flag}")
        except Exception as e:  # a party the participant cannot read is worth seeing
            print(f"{short:24s} ERROR {e}")


if __name__ == "__main__":
    main()
