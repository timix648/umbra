// ---------------------------------------------------------------------------
// WALLET SIGNATURE PROBE -- answers one question, then should be deleted.
//
// Loop (and any wallet like it) exposes signMessage() and a public key, but not
// signTransaction. That looked fatal. It is not, IF the thing signMessage signs
// is the RAW BYTES we hand it: a wallet-held key can then found a party on OUR
// validator -- where umbra is already vetted -- and sign that party's
// transactions. The wallet never sees the package and never submits, so it never
// has to vet anything, and its own node's traffic/onboarding state is irrelevant.
//
// The whole route hinges on an encoding detail nobody documents: does the wallet
// sign the bytes, or the base64 TEXT of the bytes, or a re-hash of them? Rather
// than guess -- or burn topology transactions guessing -- we take ONE signature
// and test it against every plausible encoding offline. The matching name tells
// us whether the route is open, and exactly how to drive it if so.
//
// Gated behind UMBRA_PROBE=1: it is diagnostic, not a product surface.
// ---------------------------------------------------------------------------
const crypto = require("crypto");

// Node will not build an ed25519 key from 32 raw bytes, only from DER. This is the
// fixed SPKI prefix for Ed25519; raw key appended makes a parseable SPKI document.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function ed25519FromRaw(raw) {
  if (raw.length !== 32) throw new Error(`public key must be 32 raw ed25519 bytes, got ${raw.length}`);
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki",
  });
}

// Wallets return hex or base64 with no way to tell you which. Accept both rather
// than make the caller know: hex is unambiguous enough to detect by shape.
function decodeLoose(s, label) {
  const t = String(s == null ? "" : s).trim();
  if (!t) throw new Error("need " + label);
  if (/^(0x)?[0-9a-fA-F]+$/.test(t) && t.replace(/^0x/, "").length % 2 === 0) {
    return Buffer.from(t.replace(/^0x/, ""), "hex");
  }
  return Buffer.from(t, "base64");
}

// Every encoding a wallet might plausibly have signed, in the order we care about.
// The first is the only one that lets the route work; the rest are diagnosis, so
// that a failure says WHY rather than just "no".
function candidates(multiHashB64) {
  const b64 = String(multiHashB64).trim();
  const raw = Buffer.from(b64, "base64");
  const hex = raw.toString("hex");
  return [
    { name: "raw-bytes", usable: true,
      why: "base64-decoded hash bytes -- the only encoding Canton accepts", buf: raw },
    { name: "base64-text", usable: false,
      why: "signed the base64 string as utf8 text", buf: Buffer.from(b64, "utf8") },
    { name: "hex-text", usable: false,
      why: "signed lowercase hex as utf8 text", buf: Buffer.from(hex, "utf8") },
    { name: "hex-text-upper", usable: false,
      why: "signed uppercase hex as utf8 text", buf: Buffer.from(hex.toUpperCase(), "utf8") },
    { name: "sha256-of-raw", usable: false,
      why: "wallet re-hashed the bytes before signing", buf: crypto.createHash("sha256").update(raw).digest() },
  ];
}

module.exports = function mountProbe(app) {
  if (String(process.env.UMBRA_PROBE || "") !== "1") return;

  app.post("/api/ext/probe/verify", (req, res) => {
    try {
      const b = req.body || {};
      const key = ed25519FromRaw(decodeLoose(b.publicKey, "publicKey"));
      const sig = decodeLoose(b.signature, "signature");
      const multiHash = String(b.multiHash || "").trim();
      if (!multiHash) throw new Error("need multiHash");

      const tried = candidates(multiHash).map((c) => {
        let ok = false;
        try { ok = crypto.verify(null, c.buf, key, sig); } catch { ok = false; }
        return { name: c.name, why: c.why, usable: c.usable, verified: ok };
      });
      const hit = tried.find((t) => t.verified) || null;

      res.json({
        ok: true,
        match: hit ? hit.name : null,
        usable: !!(hit && hit.usable),
        signatureBytes: sig.length,
        tried,
        verdict: !hit
          ? "no encoding matched -- the wallet prefixes or transforms the message before signing, " +
            "so this route is closed for it"
          : hit.usable
            ? "OPEN -- the wallet signs raw bytes, so it can sign for a party hosted on our validator"
            : "CLOSED as-is -- the wallet signed " + hit.name + ", not the raw bytes Canton verifies against",
      });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  console.log("[probe] /api/ext/probe/verify mounted (UMBRA_PROBE=1)");
};
