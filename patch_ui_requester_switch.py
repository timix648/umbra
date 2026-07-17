#!/usr/bin/env python3
"""
UMBRA - backend/public/index.html
=================================
Requester side can only see its FIRST live RFQ (line ~2593 pins rfqs.find(live)),
so a second RFQ -- even one that already received a quote -- gets buried and the
requester can't switch to it to award. The dealer side already solved this with a
selectable queue (selInvCid). Give the requester the same:

  1. selRfqCid state (co-located with the requester component's hooks)
  2. the focal RFQ respects the selection: selected live RFQ, else first live
  3. a compact clickable switcher listing all live RFQs (offer->want + quote count),
     shown only when there's more than one, above the focal panel.

Hand-authored React.createElement, no build step -> edit + hard-refresh.
"""
import time, shutil, sys

PATH = "backend/public/index.html"
s = open(PATH, encoding="utf-8").read(); orig = s

# 1) add selRfqCid state right after the requester component's useTheme() at ~2555.
#    That useTheme line appears 3x; the requester one is immediately followed by the
#    refPair/_liveRef block. Anchor on the unique following context.
HOOK_ANCHOR = '''  const _liveRef = rfqs.find(r => new Date(r.payload.expiresAt).getTime() > Date.now());
  const refPair = (composing || !_liveRef)'''
HOOK_NEW = '''  const [selRfqCid, setSelRfqCid] = React.useState(null); // requester-selected live RFQ
  const _liveRef = rfqs.find(r => new Date(r.payload.expiresAt).getTime() > Date.now());
  const refPair = (composing || !_liveRef)'''
assert s.count(HOOK_ANCHOR) == 1, f"hook anchor {s.count(HOOK_ANCHOR)}x"
s = s.replace(HOOK_ANCHOR, HOOK_NEW, 1)

# 2) focal RFQ respects the selection (mirror dealer's active = find(sel) || first).
SEL_ANCHOR = '''  const rfq = rfqs.find(r => !fmt(r.payload.expiresAt).dead) || null;'''
SEL_NEW = '''  const _liveRfqs = rfqs.filter(r => !fmt(r.payload.expiresAt).dead);
  const rfq = _liveRfqs.find(r => r.contractId === selRfqCid) || _liveRfqs[0] || null;'''
assert s.count(SEL_ANCHOR) == 1, f"selection anchor {s.count(SEL_ANCHOR)}x"
s = s.replace(SEL_ANCHOR, SEL_NEW, 1)

# 3) inject a clickable switcher just before the focal "Request for quote . live" section.
#    It lists every live RFQ; clicking sets selRfqCid. Uses a small inline count of
#    live quotes per RFQ so the user can see which ones have responses.
FOCAL_ANCHOR = '''        rfq ? React.createElement("section", { className: "mod mod-focal rq-head" },'''
SWITCHER = '''        _liveRfqs.length > 1 ? React.createElement("section", { className: "mod" },
          React.createElement("div", { className: "mod-h" },
            React.createElement("h2", null, "Your live requests"),
            React.createElement("span", { className: "mod-c m" }, _liveRfqs.length)),
          React.createElement("div", { className: "mod-b flush" },
            _liveRfqs.map(r => {
              const qn = quotes.filter(q =>
                (!q.payload.rfqCid || q.payload.rfqCid === r.contractId) &&
                !fmt(q.payload.validUntil).dead).length;
              const isSel = rfq && r.contractId === rfq.contractId;
              return React.createElement("button", {
                key: r.contractId,
                className: "dq-i" + (isSel ? " sel" : ""),
                onClick: () => setSelRfqCid(r.contractId),
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }
              },
                React.createElement("span", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                  React.createElement(AssetIcon, { symbol: r.payload.offerAsset.symbol, size: "sm" }),
                  React.createElement("span", { className: "m" }, Number(r.payload.offerAmount).toLocaleString(), " ", r.payload.offerAsset.symbol),
                  React.createElement("span", { style: { opacity: 0.5 } }, "\\u21c4"),
                  React.createElement(AssetIcon, { symbol: r.payload.wantAsset.symbol, size: "sm" }),
                  React.createElement("span", { className: "m" }, r.payload.wantAsset.symbol)),
                React.createElement("span", { className: "mod-c m" }, qn, qn === 1 ? " quote" : " quotes"));
            }))) : null,

        rfq ? React.createElement("section", { className: "mod mod-focal rq-head" },'''
assert s.count(FOCAL_ANCHOR) == 1, f"focal anchor {s.count(FOCAL_ANCHOR)}x"
s = s.replace(FOCAL_ANCHOR, SWITCHER, 1)

if s == orig:
    print("NO CHANGES."); sys.exit(1)
bak = f"{PATH}.pre-reqswitch-{int(time.time())}"
shutil.copyfile(PATH, bak)
open(PATH, "w", encoding="utf-8").write(s)
print("  [ok] requester can switch between live RFQs")
print(f"Backup: {bak}  ({len(orig)} -> {len(s)})")
