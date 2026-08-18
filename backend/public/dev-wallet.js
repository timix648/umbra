// DEV WALLET — a CIP-0103-shaped test double. NOT a product feature.
//
// Load with ?devwallet=1. It replaces window.CantonDapp with an object exposing
// only the surface WalletLink actually calls, and routes signing to
// /api/dev/wallet/submit (which is itself off unless UMBRA_DEV_WALLET=1).
//
// WHY THIS EXISTS: everything downstream of WalletLink.submit() was unverifiable
// because no CIP-0103 wallet is reachable on DevNet — the SDK's default gateway
// list points at a Splice Wallet Gateway on localhost:3030 that nobody runs. This
// lets the app's own logic (the resumable settle loop, proposal matching, the
// desks) be proven now, and swapped for a real wallet later without touching a
// line of app code.
//
// WHAT IT DOES NOT PROVE: custody. The key lives on the server by construction.
// The custody property is proven separately by backend/wallet_*_demo.js, where a
// key generated outside the server signs every party-side command. Do not cite
// this file as evidence for that claim.
//
// The real SDK's exports are non-configurable getters, so this replaces the whole
// global rather than patching a method onto it.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  if (q.get("devwallet") !== "1") return;

  function jfetch(path, body) {
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { j = { raw: t }; }
        if (!r.ok) throw new Error(j.error || j.raw || (r.status + " error"));
        return j;
      });
    });
  }

  var account = null;      // the wallet party we stand in for
  var connected = false;

  // Pick the party to act as: ?devparty=<id>, else the first onboarded wallet.
  function loadAccount() {
    if (account) return Promise.resolve(account);
    return jfetch("/api/ext/wallets").then(function (r) {
      var list = (r && r.wallets) || [];
      var want = q.get("devparty");
      var w = want ? list.find(function (x) { return x.partyId === want; }) : list[0];
      if (!w) throw new Error("dev wallet: no onboarded wallet party to act as");
      account = {
        partyId: w.partyId,
        hint: String(w.partyId).split("::")[0],
        publicKey: null,
        namespace: String(w.partyId).split("::")[1] || null,
        networkId: "devnet",
        primary: true,
        disabled: false
      };
      return account;
    });
  }

  window.CantonDapp = {
    __devWallet: true,

    init: function () { return loadAccount().then(function () { return true; }); },

    isConnected: function () {
      return Promise.resolve({ isConnected: connected });
    },

    // A real wallet opens a picker here and needs a user gesture. This one just
    // says yes, which is precisely why it cannot answer "does the picker work".
    connect: function () {
      return loadAccount().then(function () {
        connected = true;
        return { isConnected: true, kernel: "dev-wallet", provider: "stub" };
      });
    },

    disconnect: function () { connected = false; return Promise.resolve(true); },

    listAccounts: function () {
      return loadAccount().then(function (a) { return [a]; });
    },

    // The one that matters. Mirrors prepareExecuteAndWait: resolve only once the
    // ledger has actually committed, and surface a rejection as a failure.
    prepareExecuteAndWait: function (params) {
      return loadAccount().then(function (a) {
        return jfetch("/api/dev/wallet/submit", {
          party: a.partyId,
          commands: (params && params.commands) || [],
          disclosedContracts: (params && params.disclosedContracts) || [],
          tag: "devwallet"
        });
      }).then(function (r) {
        return {
          tx: {
            status: r.committed ? "executed" : "signed",
            commandId: r.commandId || null,
            updateId: null
          }
        };
      }).catch(function (e) {
        return { tx: { status: "failed", error: String(e.message || e) } };
      });
    },

    // Proxy to a ledger API. A real wallet sends this to the USER's validator; this
    // stub has only Umbra's, which is the one thing it cannot faithfully imitate —
    // the stub's party happens to be hosted there, so reads succeed for the wrong
    // reason. Exercises the call shape, proves nothing about foreign hosting.
    ledgerApi: function (params) {
      var p = params || {};
      var qs = "";
      if (p.query && Object.keys(p.query).length) {
        qs = "?" + Object.keys(p.query).map(function (k) {
          return encodeURIComponent(k) + "=" + encodeURIComponent(p.query[k]);
        }).join("&");
      }
      var res = String(p.resource || "");
      if (p.path) Object.keys(p.path).forEach(function (k) {
        res = res.replace("{" + k + "}", encodeURIComponent(p.path[k]));
      });
      return jfetch("/api/dev/wallet/ledger" + "?resource=" + encodeURIComponent(res + qs) +
        "&method=" + encodeURIComponent(p.requestMethod || "get"),
        p.body ? { body: p.body } : { body: null });
    },

    signMessage: function () {
      return Promise.reject(new Error("dev wallet: signMessage is not implemented"));
    },

    on: function () {}, removeListener: function () {}, emit: function () {}
  };

  console.log("[dev-wallet] active — window.CantonDapp replaced with a test double");
})();
