#!/usr/bin/env python3
"""
UMBRA - backend/public/index.html
=================================
Point the Holdings panel at REAL balances. It currently reads /api/swap/holdings
(stand-in AssetHolding) -> shows "No assets yet" now that we trade real tokens.
Fetch /api/real/holdings for each role, keep only issuer-issued (real) holdings,
and map them into the shape the panel expects ({payload:{asset:{symbol},amount,owner}}).

Symbol normalize: real instrument "Amulet" -> display "CC" (matches the rest of the UI).
Hand-authored React.createElement, no build step -> edit + hard-refresh.
"""
import time, shutil, sys

PATH = "backend/public/index.html"
s = open(PATH, encoding="utf-8").read(); orig = s

# 1) add three real-holdings fetches to the Promise.all (after shd2's swap/holdings fetch)
OLD_FETCH = '''api("/api/swap/holdings?role=requester").catch(() => ({})), api("/api/swap/holdings?role=dealer1").catch(() => ({})), api("/api/swap/holdings?role=dealer2").catch(() => ({}))]);'''
NEW_FETCH = '''api("/api/swap/holdings?role=requester").catch(() => ({})), api("/api/swap/holdings?role=dealer1").catch(() => ({})), api("/api/swap/holdings?role=dealer2").catch(() => ({})), api("/api/real/holdings?role=requester").catch(() => ({})), api("/api/real/holdings?role=dealer1").catch(() => ({})), api("/api/real/holdings?role=dealer2").catch(() => ({}))]);'''
assert s.count(OLD_FETCH) == 1, f"fetch anchor {s.count(OLD_FETCH)}x"
s = s.replace(OLD_FETCH, NEW_FETCH, 1)

# add the three new vars to the destructure (append before the closing ] of the assignment)
OLD_DESTR = '''shr, shd1, shd2] = await Promise.all(['''
NEW_DESTR = '''shr, shd1, shd2, rhr, rhd1, rhd2] = await Promise.all(['''
assert s.count(OLD_DESTR) == 1, f"destructure anchor {s.count(OLD_DESTR)}x"
s = s.replace(OLD_DESTR, NEW_DESTR, 1)

# 2) add a mapper helper + feed real holdings into `assets`
OLD_SET = '''      setHold({
        requester: {
          cash: hr.cash || [],
          instruments: hr.instruments || [],
          assets: (shr && shr.holdings) || []
        },
        dealer1: {
          cash: hd1.cash || [],
          instruments: hd1.instruments || [],
          assets: (shd1 && shd1.holdings) || []
        },
        dealer2: {
          cash: hd2.cash || [],
          instruments: hd2.instruments || [],
          assets: (shd2 && shd2.holdings) || []
        }
      });'''
NEW_SET = '''      // Map REAL /api/real/holdings (raw, issuer-issued only) into the panel's
      // holding shape. Skip self-issued stand-ins (admin hint in our own parties)
      // and null views. "Amulet" -> "CC" for display consistency.
      const OURS = { Requester: 1, Dealer1: 1, Dealer2: 1, Observer: 1 };
      const realAssets = (rh, ownerHint) => ((rh && rh.raw) || [])
        .filter(h => {
          const iss = String(h.admin || "").split("::")[0];
          return h.id && h.admin && !OURS[iss];
        })
        .map(h => ({
          contractId: h.contractId,
          payload: {
            asset: { symbol: h.id === "Amulet" ? "CC" : h.id, admin: h.admin },
            amount: h.amount,
            owner: h.owner || ownerHint
          }
        }));
      setHold({
        requester: {
          cash: hr.cash || [],
          instruments: hr.instruments || [],
          assets: realAssets(rhr, "requester")
        },
        dealer1: {
          cash: hd1.cash || [],
          instruments: hd1.instruments || [],
          assets: realAssets(rhd1, "dealer1")
        },
        dealer2: {
          cash: hd2.cash || [],
          instruments: hd2.instruments || [],
          assets: realAssets(rhd2, "dealer2")
        }
      });'''
assert s.count(OLD_SET) == 1, f"setHold anchor {s.count(OLD_SET)}x"
s = s.replace(OLD_SET, NEW_SET, 1)

if s == orig:
    print("NO CHANGES."); sys.exit(1)
bak = f"{PATH}.pre-realholdings-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  [ok] Holdings panel now shows REAL balances")
print(f"Backup: {bak}  ({len(orig)} -> {len(s)})")
