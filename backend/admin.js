// The venue's admin dashboard: /admin, behind a password. Nothing in the app links
// here. Every number comes from the ledger (the venue's party observes every request,
// deal and settlement receipt) or from the server's own records (wallets, faucet).
//
//   Set the password:   node backend/admin.js hash 'a long passphrase'
//                       -> UMBRA_ADMIN_PASSWORD_HASH=scrypt$<salt>$<hash> in backend/.env
//   Without it, /api/admin/* answers 503 and the page says admin is not set up.
const crypto = require("crypto");
const path = require("path");

const COOKIE = "umbra_admin";
const TTL_MS = 8 * 3600 * 1000;
const HASH = String(process.env.UMBRA_ADMIN_PASSWORD_HASH || "").trim();
// Signs the admin session cookie. Its own secret if given; else derived from the
// app's session secret so it still survives restarts.
const KEY = process.env.UMBRA_ADMIN_SECRET
  ? Buffer.from(process.env.UMBRA_ADMIN_SECRET)
  : crypto.createHmac("sha256", String(process.env.UMBRA_SESSION_SECRET || crypto.randomBytes(32).toString("hex")))
      .update("umbra-admin").digest();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + h.toString("hex");
}
function checkPassword(pw) {
  const [kind, saltHex, hashHex] = HASH.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = crypto.scryptSync(String(pw || ""), Buffer.from(saltHex, "hex"), want.length);
  return crypto.timingSafeEqual(got, want);
}

const sign = (s) => crypto.createHmac("sha256", KEY).update(s).digest("base64url");
function mintCookie() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS })).toString("base64url");
  return body + "." + sign(body);
}
function cookieOk(req) {
  const raw = String(req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return false;
  const [body, mac] = raw.slice(COOKIE.length + 1).split(".");
  if (!body || !mac) return false;
  const good = Buffer.from(sign(body)), given = Buffer.from(mac);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return false;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > Date.now(); } catch { return false; }
}
function setCookie(req, res, value, maxAgeMs) {
  const https = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
  res.set("Set-Cookie", COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
    Math.floor(maxAgeMs / 1000) + (https ? "; Secure" : ""));
}

// Five wrong passwords from one address locks that address out for 15 minutes.
const fails = new Map();
function lockedOut(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60000) { fails.delete(ip); return false; }
  return f.n >= 5;
}
function failed(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > 15 * 60000) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
}

const num = (x) => { const n = Number(x); return isFinite(n) ? n : 0; };
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
// wallet-1790138473268::12205b7d... -> "wallet …3268 · 205b7d"
const short = (p) => {
  const [h, f] = String(p).split("::");
  const m = h.match(/^(.*)-([0-9a-f]{4,})$/i);
  return (m ? m[1] + " …" + m[2].slice(-4) : h) + (f ? " · " + f.slice(4, 10) : "");
};

// deps: { partyIdFor, queryActive, marketUsd, feedTicker, loadWallets, loadDealerDirectory, faucetLog, campaign }
function mountAdmin(app, deps) {
  const enabled = () => !!HASH;
  const guard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!enabled()) return res.status(503).json({ error: "admin is not set up on this server" });
    if (!cookieOk(req)) return res.status(401).json({ error: "sign in" });
    next();
  };

  app.get("/admin", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  });

  app.post("/api/admin/login", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!enabled()) return res.status(503).json({ error: "admin is not set up on this server" });
    const ip = String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
    if (lockedOut(ip)) return res.status(429).json({ error: "too many attempts, try again in 15 minutes" });
    if (!checkPassword((req.body || {}).password)) {
      failed(ip);
      return res.status(401).json({ error: "wrong password" });
    }
    fails.delete(ip);
    setCookie(req, res, mintCookie(), TTL_MS);
    res.json({ ok: true, expiresInMs: TTL_MS });
  });

  app.post("/api/admin/logout", (req, res) => { setCookie(req, res, "", 0); res.json({ ok: true }); });

  app.get("/api/admin/me", guard, (req, res) => res.json({ ok: true }));

  async function collect(q) {
    const venue = await deps.partyIdFor("requester");
    const [receipts, rfqs, usd, dir] = await Promise.all([
      deps.queryActive(venue, "UmbraSwap:SettlementReceipt").catch(() => []),
      deps.queryActive(venue, "UmbraSwap:SwapRfq").catch(() => []),
      deps.marketUsd().catch(() => ({})),
      deps.loadDealerDirectory().catch(() => null),
    ]);
    const tick = deps.feedTicker();
    const px = (sym) => num(usd[tick(sym)]);
    const from = q.from ? Date.parse(q.from) : 0;
    const to = q.to ? Date.parse(q.to) + 86400000 : Infinity;
    const camp = q.campaign ? String(q.campaign) : "";

    const trades = receipts.map((r) => {
      const p = r.payload || {};
      const os = (p.offerAsset || {}).symbol, ws = (p.wantAsset || {}).symbol;
      const oa = num(p.offerAmount), wa = num(p.price), fee = num(p.feeAmount);
      const usdVal = px(os) ? oa * px(os) : wa * px(ws);
      return {
        at: Date.parse(p.executedAt) || 0, requester: p.requester, dealer: p.dealer,
        offerSym: tick(os), offerAmt: oa, wantSym: tick(ws), wantAmt: wa,
        fee, feeUsd: fee * px(ws), usd: usdVal, awardId: p.awardId || null, campaign: p.campaign || null,
        refMid: p.refMid != null ? num(p.refMid) : null, cid: r.contractId,
      };
    });
    const campaigns = [...new Set(trades.map((t) => t.campaign).filter(Boolean))].sort();
    const inRange = trades.filter((t) => t.at >= from && t.at < to && (!camp || t.campaign === camp));

    const wallets = Object.values(deps.loadWallets() || {});
    const newWallets = wallets.map((w) => Date.parse(w.onboardedAt) || 0).filter((t) => t >= from && t < to);

    // day by day, over the range (or the last 30 days when the range is open)
    const end = isFinite(to) ? Math.min(to, Date.now() + 86400000) : Date.now() + 86400000;
    const start = from || end - 31 * 86400000;
    const days = {};
    for (let t = start; t < end; t += 86400000) days[dayOf(t)] = { day: dayOf(t), trades: 0, volumeUsd: 0, newWallets: 0 };
    for (const t of inRange) { const d = days[dayOf(t.at)]; if (d) { d.trades++; d.volumeUsd += t.usd; } }
    for (const t of newWallets) { const d = days[dayOf(t)]; if (d) d.newWallets++; }

    const pairs = {};
    for (const t of inRange) {
      const k = t.offerSym + " → " + t.wantSym;
      const e = pairs[k] || (pairs[k] = { pair: k, trades: 0, volumeUsd: 0 });
      e.trades++; e.volumeUsd += t.usd;
    }
    const board = {};
    const credit = (party, t, side) => {
      const e = board[party] || (board[party] = { party, name: short(party), trades: 0, volumeUsd: 0, asRequester: 0, asDealer: 0 });
      e.trades++; e.volumeUsd += t.usd; e[side]++;
    };
    for (const t of inRange) { credit(t.requester, t, "asRequester"); credit(t.dealer, t, "asDealer"); }

    const fees = {};
    for (const t of inRange) if (t.fee) fees[t.wantSym] = (fees[t.wantSym] || 0) + t.fee;
    const faucet = Object.values(deps.faucetLog() || {}).flat().filter((x) => x && Date.now() - x.at < 86400000);
    const listed = dir && dir.dealers ? Object.keys(dir.dealers).length : null;

    return {
      generatedAt: new Date().toISOString(), filter: { from: q.from || null, to: q.to || null, campaign: camp || null },
      prices: usd, pricesNote: "USD at current prices; receipts record amounts, not USD",
      activeCampaign: deps.campaign || null, campaigns,
      totals: {
        wallets: wallets.length, newWallets: newWallets.length, dealersListed: listed,
        traders: Object.keys(board).length, trades: inRange.length,
        awards: new Set(inRange.map((t) => t.awardId || t.cid)).size,
        volumeUsd: inRange.reduce((s, t) => s + t.usd, 0),
        feesUsd: inRange.reduce((s, t) => s + t.feeUsd, 0), fees,
        liveRequests: rfqs.length,
        faucetTaps24h: faucet.length, faucetCc24h: faucet.reduce((s, x) => s + num(x.amount), 0),
      },
      daily: Object.values(days).sort((a, b) => a.day < b.day ? -1 : 1),
      pairs: Object.values(pairs).sort((a, b) => b.volumeUsd - a.volumeUsd),
      leaderboard: Object.values(board).sort((a, b) => b.volumeUsd - a.volumeUsd),
      recent: inRange.slice().sort((a, b) => b.at - a.at).slice(0, 25)
        .map((t) => Object.assign({}, t, { requester: short(t.requester), dealer: short(t.dealer) })),
    };
  }

  app.get("/api/admin/stats", guard, async (req, res) => {
    try { res.json(await collect(req.query || {})); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/api/admin/leaderboard.csv", guard, async (req, res) => {
    try {
      const s = await collect(req.query || {});
      const esc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
      const lines = [["rank", "party", "trades", "volume_usd", "as_requester", "as_dealer"].join(",")]
        .concat(s.leaderboard.map((e, i) => [i + 1, e.party, e.trades, e.volumeUsd.toFixed(2), e.asRequester, e.asDealer].map(esc).join(",")));
      res.set("Content-Type", "text/csv");
      res.set("Content-Disposition", 'attachment; filename="umbra-leaderboard' + (s.filter.campaign ? "-" + s.filter.campaign : "") + '.csv"');
      res.send(lines.join("\n") + "\n");
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { mountAdmin, hashPassword };

if (require.main === module && process.argv[2] === "hash") {
  const pw = process.argv[3];
  if (!pw || pw.length < 12) { console.error("usage: node admin.js hash '<passphrase of 12+ characters>'"); process.exit(1); }
  console.log("UMBRA_ADMIN_PASSWORD_HASH=" + hashPassword(pw));
}
