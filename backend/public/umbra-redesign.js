/* ══════════════════════════════════════════════════════════════════════════
   UMBRA — REDESIGN COMPONENTS
   React.createElement only. No JSX, no build step, no imports.
   Drop this block into backend/public/index.html above your app component.

   Uses the existing global AssetIcon when present (feature-detected, so this
   file also runs standalone in the preview harness).
   Everything is exported on window.UmbraRedesign for incremental adoption.
   ══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* React is reached lazily so load order never matters. */
  function R() { return window.React; }
  function h() { return R().createElement.apply(null, arguments); }
  function frag() {
    var a = [R().Fragment, null].concat(Array.prototype.slice.call(arguments));
    return R().createElement.apply(null, a);
  }

  /* ── asset registry ───────────────────────────────────────────────────
     Single source of truth for symbol → name → issuer. Anywhere an asset is
     named it renders through AssetTag, so identity is never partial.        */
  var ASSETS = {
    cBTC: { sym: "cBTC", name: "Bitcoin", issuer: "BitSafe", dp: 7 },
    cETH: { sym: "cETH", name: "Ethereum", issuer: "onRails", dp: 7 },
    CC: { sym: "CC", name: "Canton Coin", issuer: "Canton Foundation", dp: 7 }
  };
  function meta(sym) {
    return ASSETS[sym] || { sym: sym || "—", name: "", issuer: "Unlisted issuer", dp: 7 };
  }
  function dpOf(sym) { return meta(sym).dp; }

  /* ── party ids ────────────────────────────────────────────────────────── */
  /* wallet-1787139915133::12209b289fe93cbdd3923fe27eef86f13… → wallet-1787…29f8 */
  function abbrevParty(p, head, tail) {
    if (!p) return "—";
    p = String(p).trim();
    head = head == null ? 11 : head;
    tail = tail == null ? 4 : tail;
    if (p.length <= head + tail + 1) return p;
    return p.slice(0, head) + "…" + p.slice(-tail);
  }
  /* Shorter form for dense rows: fingerprint tail only. */
  function partyTail(p, n) {
    if (!p) return "—";
    p = String(p).trim();
    return "…" + p.slice(-(n == null ? 8 : n));
  }

  /* ══ BUG FIX ══════════════════════════════════════════════════════════
     `dest === home` was false for the user's own wallet. Party ids arrive
     from three places that do not agree byte-for-byte:
       • the ledger    → "wallet-1787139915133::12209b28…"
       • the wallet API → sometimes wrapped in quotes / trailing \n
       • a text input   → leading or trailing whitespace, NBSP from a paste
     and the hex fingerprint casing is not stable across sources.
     Compare through this, never with ===.                                  */
  function normParty(p) {
    return String(p == null ? "" : p)
      .replace(/\u00a0/g, " ")   // NBSP from clipboard pastes
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .toLowerCase();
  }
  function samePartyId(a, b) {
    a = normParty(a); b = normParty(b);
    return a !== "" && a === b;
  }

  /* ── amounts ──────────────────────────────────────────────────────────
     7dp must survive. Never round a non-zero balance to "0": below the last
     decimal place we say so explicitly instead of lying with a zero.        */
  function parseAmt(v) {
    var n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(/,/g, ""));
    return isFinite(n) ? n : 0;
  }
  function amtParts(v, dp) {
    dp = dp == null ? 7 : dp;
    var n = parseAmt(v), neg = n < 0;
    var fixed = Math.abs(n).toFixed(dp);
    var seg = fixed.split(".");
    var frac = seg[1] || "";
    var sig = frac.replace(/0+$/, "");
    return {
      neg: neg,
      int: seg[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","),
      sig: sig,
      pad: frac.slice(sig.length),
      underflow: n !== 0 && parseFloat(fixed) === 0,
      dp: dp
    };
  }
  /* Amount({v, sym, dp, pad, plain, cls}) */
  function Amount(props) {
    var dp = props.dp == null ? dpOf(props.sym) : props.dp;
    var p = amtParts(props.v, dp);
    var cls = "u-num" + (props.cls ? " " + props.cls : "");
    var unit = props.sym ? h("span", { className: "u-unit" }, props.sym) : null;

    if (p.underflow) {
      return h("span", { className: cls, title: String(props.v) },
        h("span", { className: "u-tiny" }, "<0." + new Array(dp).join("0") + "1"), unit);
    }

    var body;
    var lead = p.sig.match(/^0*/)[0].length;
    if (!props.plain && lead >= 4 && p.sig.length > lead) {
      /* 0.00000125 → 0.₆125 — compressed only past four zeros, so the
         everyday 7dp values (0.000125) still print in full. */
      body = frag(p.int, ".", h("sub", null, String(lead)), p.sig.slice(lead));
    } else if (p.sig) {
      body = frag(p.int, ".", p.sig,
        props.pad && p.pad ? h("span", { className: "u-tz" }, p.pad) : null);
    } else {
      body = frag(p.int,
        props.pad ? frag(".", h("span", { className: "u-tz" }, new Array(dp + 1).join("0"))) : null);
    }
    return h("span", { className: cls, title: props.title || String(props.v) },
      p.neg ? "−" : "", body, unit);
  }

  /* ── icons ────────────────────────────────────────────────────────────── */
  function hasAssetIcon() { return typeof window.AssetIcon === "function"; }
  function Icon(props) {
    var size = props.size || 22;
    if (hasAssetIcon()) return h(window.AssetIcon, { sym: props.sym, symbol: props.sym, size: size });
    return h("span", {
      className: "u-glyph",
      style: { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.4)) },
      "aria-hidden": "true"
    }, String(props.sym || "?").replace(/^c/, "").slice(0, 2).toUpperCase());
  }

  /* AssetTag({sym, size, issuer:false, inline}) */
  function AssetTag(props) {
    var m = meta(props.sym);
    var showIssuer = props.issuer !== false;
    return h("span", { className: "u-asset" + (props.inline ? " u-asset-inline" : "") },
      h(Icon, { sym: m.sym, size: props.size || (props.inline ? 16 : 22) }),
      h("span", { className: "u-asset-txt" },
        h("span", { className: "u-asset-sym" }, m.sym),
        showIssuer && m.name
          ? h("span", { className: "u-asset-iss" }, m.name + " · " + m.issuer)
          : null));
  }

  /* ── copy ─────────────────────────────────────────────────────────────── */
  function CopyBtn(props) {
    var st = R().useState(false), done = st[0], setDone = st[1];
    return h("button", {
      type: "button",
      className: "u-btn u-btn-xs",
      title: "Copy " + (props.what || "value"),
      onClick: function (e) {
        e.stopPropagation();
        var t = String(props.text || "");
        if (navigator.clipboard) navigator.clipboard.writeText(t);
        setDone(true);
        setTimeout(function () { setDone(false); }, 1400);
      }
    }, done ? "Copied" : "Copy");
  }

  /* ══ USelect ══════════════════════════════════════════════════════════
     One dropdown for the whole venue. Replaces every native <select>.
     options: [{ value, label, sub, right, rightLabel, sym, disabled }]
     Row anatomy: icon · label + secondary line · right-aligned value.     */
  function USelect(props) {
    var Rx = R();
    var open = Rx.useState(false), isOpen = open[0], setOpen = open[1];
    var cur = Rx.useState(-1), curIdx = cur[0], setCur = cur[1];
    var up = Rx.useState(false), flip = up[0], setFlip = up[1];
    var wrap = Rx.useRef(null);
    var opts = props.options || [];
    var idx = -1;
    for (var i = 0; i < opts.length; i++) if (opts[i].value === props.value) idx = i;
    var sel = idx >= 0 ? opts[idx] : null;

    Rx.useEffect(function () {
      if (!isOpen) return;
      function away(e) { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); }
      function key(e) { if (e.key === "Escape") { setOpen(false); } }
      document.addEventListener("mousedown", away);
      document.addEventListener("keydown", key);
      var r = wrap.current && wrap.current.getBoundingClientRect();
      setFlip(!!r && window.innerHeight - r.bottom < 260 && r.top > 260);
      setCur(idx);
      return function () {
        document.removeEventListener("mousedown", away);
        document.removeEventListener("keydown", key);
      };
    }, [isOpen, idx]);

    function pick(o) {
      if (o.disabled) return;
      setOpen(false);
      if (props.onChange) props.onChange(o.value, o);
    }
    function onKey(e) {
      var k = e.key;
      if (!isOpen && (k === "Enter" || k === " " || k === "ArrowDown" || k === "ArrowUp")) {
        e.preventDefault(); setOpen(true); return;
      }
      if (!isOpen) return;
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        var n = opts.length, step = k === "ArrowDown" ? 1 : -1, j = curIdx;
        for (var t = 0; t < n; t++) {
          j = (j + step + n) % n;
          if (!opts[j].disabled) break;
        }
        setCur(j);
      } else if (k === "Enter" && curIdx >= 0) {
        e.preventDefault(); pick(opts[curIdx]);
      } else if (k === "Tab") { setOpen(false); }
    }

    function row(o, i) {
      var on = o.value === props.value;
      return h("button", {
        key: String(o.value) + i,
        type: "button",
        className: "u-sel-opt",
        role: "option",
        "aria-selected": on ? "true" : "false",
        "data-on": on ? "1" : "0",
        "data-cur": i === curIdx ? "1" : "0",
        disabled: !!o.disabled,
        onMouseEnter: function () { setCur(i); },
        onClick: function () { pick(o); }
      },
        h("span", { className: "u-sel-tick" }, on ? "●" : ""),
        o.sym ? h(Icon, { sym: o.sym, size: 20 }) : null,
        h("span", { className: "u-sel-main" },
          h("span", { className: "u-asset-txt" },
            h("span", { className: "u-asset-sym" }, o.label),
            o.sub ? h("span", { className: "u-asset-iss" }, o.sub) : null)),
        o.right != null
          ? h("span", { className: "u-sel-side" },
              h("span", { className: "u-sel-side-v" }, o.right),
              o.rightLabel ? h("span", { className: "u-sel-side-l" }, o.rightLabel) : null)
          : null);
    }

    return h("div", { className: "u-sel", ref: wrap },
      h("button", {
        type: "button",
        className: "u-sel-btn",
        disabled: !!props.disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": isOpen ? "true" : "false",
        "aria-label": props.ariaLabel || props.placeholder || "Select",
        onKeyDown: onKey,
        onClick: function () { setOpen(!isOpen); }
      },
        sel && sel.sym ? h(Icon, { sym: sel.sym, size: 22 }) : null,
        h("span", { className: "u-sel-main" },
          sel
            ? h("span", { className: "u-asset-txt" },
                h("span", { className: "u-asset-sym" }, sel.label),
                sel.sub ? h("span", { className: "u-asset-iss" }, sel.sub) : null)
            : h("span", { className: "u-sel-ph" }, props.placeholder || "Select…")),
        sel && sel.right != null
          ? h("span", { className: "u-sel-side" },
              h("span", { className: "u-sel-side-v" }, sel.right),
              sel.rightLabel ? h("span", { className: "u-sel-side-l" }, sel.rightLabel) : null)
          : null,
        h("span", { className: "u-car" })),
      isOpen
        ? h("div", { className: "u-sel-pop", role: "listbox", "data-up": flip ? "1" : "0" },
            props.groupLabel ? h("div", { className: "u-sel-grp u-lab" }, props.groupLabel) : null,
            opts.length
              ? opts.map(row)
              : h("div", { className: "u-sel-empty u-lab" }, "No options"))
        : null);
  }

  /* AssetSelect — USelect preconfigured with icon, issuer and balance.
     balances: { cBTC: 0.000125, … } (optional)                            */
  function AssetSelect(props) {
    var syms = props.assets || Object.keys(ASSETS);
    var bal = props.balances || null;
    return h(USelect, {
      value: props.value,
      disabled: props.disabled,
      placeholder: props.placeholder || "Select asset",
      ariaLabel: props.ariaLabel || "Asset",
      groupLabel: props.groupLabel || (bal ? "Asset · available" : "Asset"),
      onChange: props.onChange,
      options: syms.map(function (s) {
        var m = meta(s);
        var o = { value: s, sym: s, label: m.sym, sub: m.name + " · " + m.issuer };
        if (bal) {
          o.right = h(Amount, { v: bal[s] || 0, dp: m.dp });
          o.rightLabel = "available";
        }
        return o;
      })
    });
  }

  /* ══ Dealer directory ═════════════════════════════════════════════════
     Dealers self-list, so this is a searchable directory, not a chip row.
     Scales past 100 rows: filtered list is windowed to `cap` with a
     "show more" step, and selection lives outside the filter.             */
  function initials(name) {
    return String(name || "?").replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/)
      .slice(0, 2).map(function (w) { return w[0]; }).join("").toUpperCase();
  }
  function dealerHay(d) {
    return [d.name, d.party, d.desk, (d.assets || []).join(" ")].join(" ").toLowerCase();
  }

  function DealerList(props) {
    var Rx = R();
    var q = Rx.useState(""), query = q[0], setQuery = q[1];
    var c = Rx.useState(props.cap || 40), cap = c[0], setCap = c[1];
    var dealers = props.dealers || [];
    var sel = props.selected || [];
    var isOn = function (id) { return sel.indexOf(id) >= 0; };

    var needle = query.trim().toLowerCase();
    var hits = needle
      ? dealers.filter(function (d) { return dealerHay(d).indexOf(needle) >= 0; })
      : dealers;
    var shown = hits.slice(0, cap);

    function toggle(id) {
      var next = isOn(id) ? sel.filter(function (x) { return x !== id; }) : sel.concat([id]);
      if (props.onChange) props.onChange(next);
    }

    return frag(
      h("div", { className: "u-dd-head" },
        h("div", { className: "u-search u-field" },
          h("span", { className: "u-search-i" }),
          h("input", {
            value: query,
            placeholder: "Search dealers, assets, party id…",
            "aria-label": "Search dealer directory",
            onChange: function (e) { setQuery(e.target.value); setCap(props.cap || 40); }
          }),
          query ? h("button", {
            type: "button", className: "u-chip-x", "aria-label": "Clear search",
            onClick: function () { setQuery(""); }
          }, "×") : null),
        h("div", { className: "u-dd-bar" },
          h("span", { className: "u-lab" },
            hits.length + (needle ? " matching" : " listed") + " · " + sel.length + " invited"),
          h("div", { className: "u-row", style: { gap: 6 } },
            needle && hits.length
              ? h("button", {
                  type: "button", className: "u-btn u-btn-xs",
                  onClick: function () {
                    var ids = hits.map(function (d) { return d.id; });
                    var next = sel.slice();
                    ids.forEach(function (i) { if (next.indexOf(i) < 0) next.push(i); });
                    props.onChange && props.onChange(next);
                  }
                }, "Invite " + hits.length)
              : null,
            sel.length
              ? h("button", {
                  type: "button", className: "u-btn u-btn-xs",
                  onClick: function () { props.onChange && props.onChange([]); }
                }, "Clear")
              : null))),

      h("div", { className: "u-dd-list" },
        shown.length
          ? shown.map(function (d) {
              var on = isOn(d.id);
              return h("button", {
                key: d.id, type: "button", className: "u-dd-row",
                "data-on": on ? "1" : "0", role: "checkbox", "aria-checked": on ? "true" : "false",
                onClick: function () { toggle(d.id); }
              },
                h("span", { className: "u-box" }, on ? "✓" : ""),
                h("span", { className: "u-av" }, initials(d.name)),
                h("span", { className: "u-col" },
                  h("span", { className: "u-dd-name" },
                    h("span", { className: "u-trunc" }, d.name),
                    d.self ? h("span", { className: "u-tag u-tag-a" }, "You") : null,
                    d.warm ? h("span", { className: "u-tag u-tag-w" }, "New") : null),
                  h("span", { className: "u-dd-meta" },
                    h("span", { className: "u-party" }, partyTail(d.party)),
                    (d.assets || []).slice(0, 3).map(function (s) {
                      return h("span", { className: "u-tag", key: s },
                        h("span", { className: "u-asset-inline" },
                          h(Icon, { sym: s, size: 12 }), s));
                    }))),
                h("span", { className: "u-dd-stats" },
                  h("span", { className: "u-sel-side-v u-num-xs" }, d.responseTime || "—"),
                  h("span", { className: "u-sel-side-l" },
                    (d.fills != null ? d.fills + " fills" : d.desk || ""))));
            })
          : h("div", { className: "u-empty u-lab" }, "No dealer matches “" + query + "”")),

      hits.length > shown.length
        ? h("div", { className: "u-dd-foot" },
            h("span", { className: "u-lab" }, "Showing " + shown.length + " of " + hits.length),
            h("button", {
              type: "button", className: "u-btn u-btn-xs",
              onClick: function () { setCap(cap + 40); }
            }, "Show 40 more"))
        : h("div", { className: "u-dd-foot" },
            h("span", { className: "u-lab" }, "Dealers self-list · invite-only visibility"),
            props.onDone
              ? h("button", { type: "button", className: "u-btn u-btn-xs", onClick: props.onDone }, "Done")
              : null));
  }

  /* DealerField — the INVITE DEALERS control: chips + directory popover. */
  function DealerField(props) {
    var Rx = R();
    var o = Rx.useState(false), isOpen = o[0], setOpen = o[1];
    var wrap = Rx.useRef(null);
    var dealers = props.dealers || [];
    var sel = props.selected || [];
    var byId = {};
    dealers.forEach(function (d) { byId[d.id] = d; });

    Rx.useEffect(function () {
      if (!isOpen) return;
      function away(e) { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); }
      function key(e) { if (e.key === "Escape") setOpen(false); }
      document.addEventListener("mousedown", away);
      document.addEventListener("keydown", key);
      return function () {
        document.removeEventListener("mousedown", away);
        document.removeEventListener("keydown", key);
      };
    }, [isOpen]);

    return h("div", { className: "u-sel", ref: wrap },
      h("button", {
        type: "button", className: "u-dd-trigger",
        "aria-haspopup": "dialog", "aria-expanded": isOpen ? "true" : "false",
        onClick: function () { setOpen(!isOpen); }
      },
        h("span", { className: "u-sel-main" },
          sel.length
            ? h("span", { className: "u-chips" },
                sel.slice(0, 3).map(function (id) {
                  var d = byId[id] || { name: id };
                  return h("span", { className: "u-chip", key: id },
                    h("span", { className: "u-dot" }),
                    h("span", { className: "u-trunc" }, d.name),
                    h("span", {
                      className: "u-chip-x", role: "button", "aria-label": "Remove " + d.name,
                      onClick: function (e) {
                        e.stopPropagation();
                        props.onChange && props.onChange(sel.filter(function (x) { return x !== id; }));
                      }
                    }, "×"));
                }),
                sel.length > 3
                  ? h("span", { className: "u-chip u-chip-ph" }, "+" + (sel.length - 3) + " more")
                  : null)
            : h("span", { className: "u-sel-ph" }, "Search " + dealers.length + " listed dealers…")),
        h("span", { className: "u-sel-side" },
          h("span", { className: "u-sel-side-v" }, String(sel.length)),
          h("span", { className: "u-sel-side-l" }, "invited")),
        h("span", { className: "u-car" })),
      isOpen
        ? h("div", { className: "u-dd-panel", role: "dialog", "aria-label": "Dealer directory" },
            h(DealerList, {
              dealers: dealers, selected: sel, onChange: props.onChange,
              onDone: function () { setOpen(false); }
            }))
        : null);
  }

  /* ══ Funding ══════════════════════════════════════════════════════════ */
  function FundingPanel(props) {
    var Rx = R();
    var homeParty = props.homeParty;          // the user's own wallet party
    var umbraParty = props.umbraParty;        // deposit target inside Umbra
    var balances = props.balances || {};      // what Umbra holds for this party
    var transfers = props.transfers || [];
    var canDeposit = !!props.canDeposit;      // the wallet can start a transfer itself
    var walletBal = props.walletBalances || null;   // null = the wallet did not say

    // One switch, two directions. The wallet only ever signs: a deposit is started
    // here and approved in the wallet, a withdrawal is built here and signed there.
    var md = Rx.useState(props.mode || "deposit"), mode = md[0], setMode = md[1];
    var a = Rx.useState(props.asset || "cBTC"), asset = a[0], setAsset = a[1];
    var v = Rx.useState(""), amt = v[0], setAmt = v[1];
    var d = Rx.useState(props.dest || homeParty), dest = d[0], setDest = d[1];
    var e = Rx.useState(false), editDest = e[0], setEditDest = e[1];
    var f = Rx.useState(false), showFull = f[0], setShowFull = f[1];

    var dep = mode === "deposit";
    var busy = props.busy === (dep ? "d" : "w");
    // Deposit spends the WALLET's balance, withdraw spends Umbra's. When the wallet
    // does not report its balance the cap is unknown, and the wallet itself refuses
    // an amount it cannot cover.
    var srcBal = dep ? walletBal : balances;
    var known = !!srcBal;
    var dp = dpOf(asset);
    var avail = known ? parseAmt(srcBal[asset] || 0) : 0;
    var num = parseAmt(amt);
    var pct = known && avail > 0 ? Math.min(100, Math.max(0, (num / avail) * 100)) : 0;
    var over = known && num > avail + 1e-12;
    /* BUG FIX: was `dest === homeParty` — see samePartyId above. */
    var toSelf = samePartyId(dest, homeParty);
    var valid = num > 0 && !over && (dep || normParty(dest) !== "");

    function setPct(p) {
      setAmt(avail > 0 ? (avail * p / 100).toFixed(dp).replace(/0+$/, "").replace(/\.$/, "") : "");
    }
    function switchTo(m) { if (m !== mode) { setMode(m); setAmt(""); } }

    var seg = h("div", { className: "u-seg", role: "tablist", "aria-label": "Move funds" },
      [["deposit", "Deposit"], ["withdraw", "Withdraw"]].map(function (o) {
        return h("button", {
          key: o[0], type: "button", role: "tab", className: "u-seg-b",
          "aria-selected": mode === o[0], "data-on": mode === o[0] ? "1" : "0",
          onClick: function () { switchTo(o[0]); }
        }, o[1]);
      }));

    // Asset, amount, Max, slider, available: the same form in both directions.
    var amountForm = [
      h(AssetSelect, {
        key: "as", value: asset, balances: srcBal,
        ariaLabel: dep ? "Asset to deposit" : "Asset to withdraw",
        assets: dep ? (props.depositAssets && props.depositAssets.length ? props.depositAssets : props.assets) : props.assets,
        onChange: function (s) { setAsset(s); setAmt(""); }
      }),
      h("div", { key: "fld", className: "u-field" },
        h("input", {
          value: amt, inputMode: "decimal", placeholder: "0.0000000",
          "aria-label": dep ? "Deposit amount" : "Withdraw amount",
          onChange: function (ev) { setAmt(ev.target.value.replace(/[^\d.]/g, "")); }
        }),
        h("span", { className: "u-field-aff" }, asset),
        known ? h("button", {
          type: "button", className: "u-btn u-btn-xs",
          onClick: function () { setPct(100); }
        }, "Max") : null),
      known ? h("div", { key: "sl", className: "u-slider" },
        h("input", {
          type: "range", min: 0, max: 100, step: 1, value: Math.round(pct),
          "aria-label": "Percent of available balance",
          onChange: function (ev) { setPct(parseAmt(ev.target.value)); }
        }),
        h("div", { className: "u-ticks" },
          [25, 50, 75, 100].map(function (p) {
            return h("button", {
              key: p, type: "button", className: "u-tick",
              "data-on": Math.round(pct) === p ? "1" : "0",
              onClick: function () { setPct(p); }
            }, p === 100 ? "MAX" : p + "%");
          }))) : null,
      h("div", { key: "av", className: "u-row", style: { justifyContent: "space-between" } },
        h("span", { className: "u-lab" }, dep ? "In your wallet" : "Available"),
        known ? h(Amount, { v: avail, sym: asset, cls: "u-num-xs" })
              : h("span", { className: "u-lab u-lab-b" }, "shown in your wallet"))
    ];

    var umbraBox = [
      h("div", { key: "pb", className: "u-party-box" },
        h("span", { className: "u-dot" }),
        h("span", { className: "u-col u-sp" },
          h("span", { className: "u-party" }, h("b", null, abbrevParty(umbraParty))),
          h("span", { className: "u-asset-iss" }, "Your Umbra trading party")),
        h("button", {
          type: "button", className: "u-btn u-btn-xs u-btn-gh",
          onClick: function () { setShowFull(!showFull); }
        }, showFull ? "Hide" : "Full id"),
        h(CopyBtn, { text: umbraParty, what: "party id" })),
      showFull ? h("div", { key: "pf", className: "u-party-full" }, umbraParty) : null
    ];

    /* deposit ------------------------------------------------------- */
    var depositSect = canDeposit
      ? h("div", { className: "u-sect" },
          amountForm,
          h("div", { className: "u-dest", "data-home": "1" },
            h("span", { className: "u-dot" }),
            h("span", { className: "u-col u-sp" },
              h("span", { style: { fontSize: 13, fontWeight: 600 } }, "From your wallet"),
              h("span", { className: "u-asset-iss" },
                (homeParty ? abbrevParty(homeParty, 9, 6) : "your wallet") + "  →  your Umbra party"))),
          over ? h("p", { className: "u-note u-note-w", style: { margin: 0 } },
                   "Amount exceeds what your wallet holds.") : null,
          h("button", {
            type: "button", className: "u-btn u-btn-pri u-btn-blk", disabled: !valid || busy,
            onClick: function () { props.onDeposit && props.onDeposit({ asset: asset, amount: num }); }
          }, busy ? "Approve in your wallet…" : (over ? "Insufficient " + asset : "Deposit to Umbra")),
          h("p", { className: "u-note", style: { margin: 0 } },
            "Your wallet asks you to approve the transfer, then it arrives under Incoming for one more approval."),
          h("span", { className: "u-lab", style: { marginTop: 6 } }, "Receiving from elsewhere"),
          umbraBox)
      : h("div", { className: "u-sect" },
          umbraBox,
          h("p", { className: "u-note", style: { margin: 0 } },
            "Send from your wallet",
            homeParty ? [" party ", h("span", { key: "hp", className: "u-party" }, abbrevParty(homeParty, 9, 4))] : "",
            " to this one. The transfer then appears below for you to accept."));

    /* withdraw ----------------------------------------------------- */
    var withdrawSect = h("div", { className: "u-sect" },
      amountForm,
      h("span", { className: "u-lab", style: { marginTop: 4 } }, "Destination"),
      editDest
        ? h("div", { className: "u-col", style: { gap: 7 } },
            h("div", { className: "u-field" },
              h("input", {
                value: dest || "", placeholder: "party id",
                "aria-label": "Destination party id",
                onChange: function (ev) { setDest(ev.target.value); }
              })),
            h("div", { className: "u-row", style: { gap: 6 } },
              h("button", {
                type: "button", className: "u-btn u-btn-xs",
                onClick: function () { setDest(homeParty); }
              }, "Use my wallet"),
              h("button", {
                type: "button", className: "u-btn u-btn-xs",
                onClick: function () { setEditDest(false); }
              }, "Done")))
        : h("div", { className: "u-dest", "data-home": toSelf ? "1" : "0" },
            h("span", { className: toSelf ? "u-dot" : "u-dot u-dot-m" }),
            h("span", { className: "u-col u-sp" },
              h("span", { style: { fontSize: 13, fontWeight: 600 } },
                toSelf ? "Your wallet" : "Another party"),
              h("span", { className: "u-asset-iss" }, abbrevParty(dest, 9, 6))),
            h("button", {
              type: "button", className: "u-btn u-btn-xs",
              onClick: function () { setEditDest(true); }
            }, "Change")),
      !toSelf && normParty(dest) !== ""
        ? h("p", { className: "u-note u-note-w", style: { margin: 0 } },
            "Leaves Umbra to a party you do not control. Settlement is final.")
        : null,
      over
        ? h("p", { className: "u-note u-note-w", style: { margin: 0 } },
            "Amount exceeds available " + asset + ".")
        : null,
      h("button", {
        type: "button", className: "u-btn u-btn-pri u-btn-blk", disabled: !valid || busy,
        onClick: function () { props.onWithdraw && props.onWithdraw({ asset: asset, amount: num, dest: dest }); }
      }, busy ? "Approve in your wallet…" : (over ? "Insufficient " + asset : "Send from Umbra")));

    /* incoming: where every deposit lands, whichever side is showing -- */
    var incomingSect = h("div", { className: "u-sect" },
      h("div", { className: "u-row" },
        h("span", { className: "u-lab" }, "Incoming"),
        h("span", { className: "u-sp" }),
        h("span", { className: "u-lab u-lab-b" },
          transfers.length ? transfers.length + " to accept" : "clear")),
      transfers.length
        ? h("div", null, transfers.map(function (t) {
            return h("div", { className: "u-xfer", key: t.id, "data-new": t.fresh ? "1" : "0" },
              h(AssetTag, { sym: t.asset }),
              h("span", { className: "u-col", style: { alignItems: "flex-end", gap: 3 } },
                h(Amount, { v: t.amount, sym: t.asset }),
                h("span", { className: "u-asset-iss" }, "from " + partyTail(t.from))),
              h("button", {
                type: "button", className: "u-btn u-btn-xs",
                onClick: function () { props.onAccept && props.onAccept(t); }
              }, "Accept"));
          }))
        : h("div", { className: "u-empty u-lab" }, "No incoming transfers"));

    return h("div", { className: "u-fund" },
      h("div", { className: "u-sect" }, seg),
      dep ? depositSect : withdrawSect,
      incomingSect);
  }

  /* ══ Sign-in / landing ════════════════════════════════════════════════
     Wallet connect is the product. The demo desks are scaffolding: one
     bordered strip, delete between the DEMO DESKS markers to remove.       */
  function SignIn(props) {
    var demos = props.demos || [];
    return h("div", { className: "u-in" },

      h("div", { className: "u-in-l" },
        h("div", { className: "u-col", style: { gap: 8 } },
          h("div", { className: "u-in-brand" },
            h("span", { className: "u-in-ring" }),
            h("span", { className: "u-in-word" }, "Umbra")),
          h("span", { className: "u-lab" }, "Private OTC block venue")),
        h("div", { className: "u-col", style: { gap: 18 } },
          h("h1", { className: "u-in-h" },
            "Dealers compete.", h("br"), h("span", null, "None of them can see each other.")),
          h("p", { className: "u-in-p" },
            "A buyer privately asks several dealers to price a block. Each dealer is " +
            "cryptographically blind to the others — the ledger itself withholds a rival's " +
            "quote. The winning trade settles atomically.")),
        h("div", { className: "u-in-legend" },
          h("span", { className: "u-lab" }, "Tokenised assets"),
          Object.keys(ASSETS).map(function (s) {
            return h(AssetTag, { key: s, sym: s, size: 26 });
          }))),

      h("div", { className: "u-in-r" },
        h("div", { className: "u-connect" },
          h("span", { className: "u-lab" }, "Bring your own wallet"),
          h("div", { className: "u-col", style: { gap: 10 } },
            h("h2", { className: "u-connect-h" }, "Connect a Canton wallet"),
            h("p", { className: "u-connect-p" },
              "No signup. Your wallet ", h("b", null, "is"), " the account — Umbra coordinates " +
              "the trade and never holds a key.")),
          h("button", {
            type: "button", className: "u-btn u-btn-pri u-btn-lg u-btn-blk",
            onClick: props.onConnect
          }, h("span", { className: "u-dot", style: { background: "var(--bg)" } }),
             props.connecting ? "Waiting for wallet…" : "Connect wallet"),
          h("div", { className: "u-facts" },
            [["Custody", "Keys stay in Loop"],
             ["Visibility", "Invite-only, blind"],
             ["Settlement", "Atomic, on-ledger"]].map(function (f) {
              return h("div", { className: "u-fact", key: f[0] },
                h("span", { className: "u-lab" }, f[0]),
                h("span", { className: "u-fact-v" }, f[1]));
            })),
          props.error ? h("p", { className: "u-note u-note-w", style: { margin: 0 } }, props.error) : null),

        /* ── DEMO DESKS ── scaffolding; delete this block to remove ── */
        demos.length
          ? h("div", { className: "u-demo" },
              h("div", { className: "u-row" },
                h("span", { className: "u-lab" }, "Or use a demo desk"),
                h("span", { className: "u-sp" }),
                h("span", { className: "u-lab u-lab-b" }, "no wallet · sample data")),
              h("div", { className: "u-demo-row" },
                demos.map(function (dm) {
                  return h("button", {
                    key: dm.id, type: "button", className: "u-demo-b",
                    onClick: function () { props.onDemo && props.onDemo(dm); }
                  },
                    h("span", { className: "u-dot" + (dm.role === "dealer" ? " u-dot-a" : "") }),
                    h("b", null, dm.name),
                    h("span", { className: "u-lab" }, dm.role));
                })))
          : null
        /* ── /DEMO DESKS ── */
      ));
  }

  window.UmbraRedesign = {
    ASSETS: ASSETS, meta: meta,
    abbrevParty: abbrevParty, partyTail: partyTail,
    normParty: normParty, samePartyId: samePartyId,
    parseAmt: parseAmt, amtParts: amtParts,
    Amount: Amount, Icon: Icon, AssetTag: AssetTag, CopyBtn: CopyBtn,
    USelect: USelect, AssetSelect: AssetSelect,
    DealerList: DealerList, DealerField: DealerField,
    FundingPanel: FundingPanel, SignIn: SignIn
  };
})();
