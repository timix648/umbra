/* Check a prepared transaction before the wallet signs it.
 *
 * A wallet signs a HASH. Whoever produced the hash could have hashed anything, so
 * signing it on trust means trusting the server with the user's funds. This checks,
 * in the user's own browser, that:
 *
 *   1. the hash really is the hash of the transaction that came with it
 *      (recomputed with Canton's own hashing code, core-tx-visualizer);
 *   2. the transaction acts as this party and no other;
 *   3. its top-level actions are exactly the commands the page asked for --
 *      same template or interface, same contract, same choice, same arguments;
 *   4. the numbers the user chose (a price, an amount, a size) are the ones in it.
 *
 * Anything else it refuses, and the wallet is never asked.
 *
 * What it cannot do: this file is served by the same server it checks. It stops a
 * server that builds the wrong transaction -- a bug, or an attacker in the API --
 * but not one that also rewrites this page.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.UmbraTxVerify = factory();
})(typeof self !== "undefined" ? self : this, function () {

  function Refusal(msg) {
    const e = new Error("Not signed: " + msg + ". Nothing was sent.");
    e.refused = true;
    return e;
  }

  // "#pkg:Module:Entity" or "pkgid:Module:Entity" -> "Module:Entity"
  const modEnt = (id) => {
    if (!id) return "";
    if (typeof id === "object") return (id.moduleName || "") + ":" + (id.entityName || "");
    const p = String(id).split(":");
    return p.slice(-2).join(":");
  };

  const body = (n) => {
    const t = n && n.versionedNode && n.versionedNode.v1 && n.versionedNode.v1.nodeType;
    return t ? { kind: t.oneofKind, node: t[t.oneofKind] } : { kind: null, node: null };
  };

  // Microseconds since the epoch (the ledger's time) -> milliseconds.
  const micros = (v) => Number(BigInt(String(v)) / 1000n);

  // Does the ledger value `v` say what the command's JSON `j` says? Only what the
  // command states is compared, and every stated leaf must match.
  function same(v, j, path) {
    const where = path || "argument";
    if (!v || !v.sum) throw Refusal("an argument could not be read (" + where + ")");
    const k = v.sum.oneofKind, x = v.sum[k];
    const bad = () => Refusal("the transaction differs from the request at " + where);
    switch (k) {
      case "record": {
        if (j === null || typeof j !== "object" || Array.isArray(j)) throw bad();
        const fields = x.fields || [];
        const labelled = fields.every((f) => f.label);
        const keys = Object.keys(j);
        keys.forEach((key, i) => {
          const f = labelled ? fields.find((ff) => ff.label === key) : fields[i];
          if (!f) {
            if (j[key] === null || j[key] === undefined) return;   // an absent optional
            throw bad();
          }
          same(f.value, j[key], where + "." + key);
        });
        return;
      }
      case "optional": {
        const inner = x && x.value;
        if (j === null || j === undefined) { if (inner) throw bad(); return; }
        if (!inner) throw bad();
        return same(inner, j, where);
      }
      case "list": {
        const els = (x && x.elements) || [];
        if (!Array.isArray(j) || j.length !== els.length) throw bad();
        els.forEach((e, i) => same(e, j[i], where + "[" + i + "]"));
        return;
      }
      case "textMap": {
        const es = (x && x.entries) || [];
        const jj = (j && (j.map || j)) || {};
        if (typeof jj !== "object") throw bad();
        Object.keys(jj).forEach((key) => {
          const e = es.find((ee) => ee.key === key);
          if (!e) throw bad();
          same(e.value, jj[key], where + "{" + key + "}");
        });
        return;
      }
      case "genMap": return;                       // not used by Umbra's commands
      case "variant": {
        if (!j || typeof j !== "object") throw bad();
        if (j.tag !== x.constructor) throw bad();
        if (j.value !== undefined) same(x.value, j.value, where + "<" + j.tag + ">");
        return;
      }
      case "enum": if (String(j) !== String(x.value)) throw bad(); return;
      case "numeric": if (j === null || Number(j) !== Number(x)) throw bad(); return;
      case "int64": if (String(j) !== String(x)) throw bad(); return;
      case "timestamp": {
        const ms = Date.parse(j);
        if (isNaN(ms) || Math.abs(ms - micros(x)) > 1) throw bad();
        return;
      }
      case "date": return;                         // not used by Umbra's commands
      case "bool": if (Boolean(j) !== Boolean(x)) throw bad(); return;
      case "unit": return;
      case "party": case "text": case "contractId":
        if (String(j) !== String(x)) throw bad();
        return;
      default:
        throw Refusal("an argument of an unknown kind (" + k + ") at " + where);
    }
  }

  // Walk a JSON path like "parts.0.fill" through a ledger value.
  function at(v, path) {
    let cur = v;
    for (const step of String(path).split(".")) {
      if (!cur || !cur.sum) return undefined;
      const k = cur.sum.oneofKind, x = cur.sum[k];
      if (k === "optional") { cur = x && x.value; if (!cur) return undefined; }
      const kk = cur.sum.oneofKind, xx = cur.sum[kk];
      if (kk === "record") cur = ((xx.fields || []).find((f) => f.label === step) || {}).value;
      else if (kk === "list") cur = ((xx.elements || [])[Number(step)]);
      else return undefined;
    }
    if (!cur || !cur.sum) return undefined;
    const k = cur.sum.oneofKind;
    if (k === "optional") return cur.sum.optional && cur.sum.optional.value ? leaf(cur.sum.optional.value) : null;
    return leaf(cur);
  }
  function leaf(v) { const k = v.sum.oneofKind; return v.sum[k]; }

  /* party: who is signing. commands: what the page asked the server to prepare.
   * prep: the server's answer. expect: optional { "path.to.field": value } -- the
   * numbers the user chose, checked on the first command's arguments.
   * CT: { hashPreparedTransaction, decodePreparedTransaction }. */
  async function verifyPrepared(CT, party, commands, prep, expect) {
    if (!CT || !CT.hashPreparedTransaction) throw Refusal("the transaction checker did not load -- reload the page");
    if (!prep || !prep.preparedTransaction || !prep.preparedTransactionHash) throw Refusal("the server sent no transaction");

    const h = await CT.hashPreparedTransaction(prep.preparedTransaction, "base64");
    if (h !== prep.preparedTransactionHash) throw Refusal("the transaction does not match the hash you were asked to sign");

    const tx = CT.decodePreparedTransaction(prep.preparedTransaction);
    const acts = (tx.metadata && tx.metadata.submitterInfo && tx.metadata.submitterInfo.actAs) || [];
    if (acts.length !== 1 || acts[0] !== party) throw Refusal("it would act for another party");

    const t = tx.transaction || {};
    const byId = new Map((t.nodes || []).map((n) => [n.nodeId, n]));
    const roots = (t.roots || []).map((id) => body(byId.get(id)));
    if (roots.length !== commands.length) throw Refusal("it holds " + roots.length + " actions where " + commands.length + " were asked for");

    commands.forEach((c, i) => {
      const r = roots[i];
      if (c.CreateCommand) {
        const cc = c.CreateCommand;
        if (r.kind !== "create" || modEnt(r.node.templateId) !== modEnt(cc.templateId)) throw Refusal("its action " + (i + 1) + " is not the requested create");
        same(r.node.argument, cc.createArguments, "create " + modEnt(cc.templateId));
      } else if (c.ExerciseCommand) {
        const ec = c.ExerciseCommand;
        if (r.kind !== "exercise") throw Refusal("its action " + (i + 1) + " is not the requested choice");
        const want = modEnt(ec.templateId);
        const got = [modEnt(r.node.templateId), modEnt(r.node.interfaceId)];
        if (!got.includes(want)) throw Refusal("its action " + (i + 1) + " targets a different contract type");
        if (r.node.contractId !== ec.contractId) throw Refusal("its action " + (i + 1) + " targets a different contract");
        if (r.node.choiceId !== ec.choice) throw Refusal("its action " + (i + 1) + " runs " + r.node.choiceId + ", not " + ec.choice);
        same(r.node.chosenValue, ec.choiceArgument, ec.choice);
      } else {
        throw Refusal("the page asked for a command it does not know how to check");
      }
    });

    if (expect && roots[0]) {
      const r0 = roots[0];
      const arg = r0.kind === "exercise" ? r0.node.chosenValue : r0.node.argument;
      for (const [p, want] of Object.entries(expect)) {
        const got = at(arg, p);
        // Numbers compare at the ledger's own precision (Numeric 10): the page's float
        // arithmetic can differ from the ledger's decimal in digits the ledger cannot hold.
        const ok = want === null ? got == null
          : (typeof want === "number" || /^-?[0-9.]+$/.test(String(want)))
            ? got != null && Number(got).toFixed(10) === Number(want).toFixed(10)
          : String(got) === String(want);
        if (!ok) throw Refusal(p + " is " + (got == null ? "missing" : got) + ", not " + want);
      }
    }
    return { ok: true, actions: roots.length, nodes: (t.nodes || []).length };
  }

  /* A topology change the wallet is about to sign (hosting a party on nodes).
   * Each hash must be the hash of its transaction (Canton purpose 11), each must be a
   * PartyToParticipant for THIS party, and it may name only the nodes the venue says
   * it uses. */
  async function verifyTopology(CT, party, hashes, txs, allowedParticipants) {
    if (!CT || !CT.computeSha256CantonHash || !CT.decodeTopologyTransaction) throw Refusal("the topology checker did not load -- reload the page");
    if (!Array.isArray(hashes) || !Array.isArray(txs) || !hashes.length || hashes.length !== txs.length) throw Refusal("the server sent an incomplete topology");
    const allowed = new Set(allowedParticipants || []);
    for (let i = 0; i < txs.length; i++) {
      const bytes = Uint8Array.from(atobAny(txs[i]), (c) => c.charCodeAt(0));
      const h = await CT.computeSha256CantonHash(11, bytes);
      if (b64(h) !== hashes[i]) throw Refusal("a topology hash is not the hash of its transaction");
      const d = CT.decodeTopologyTransaction(txs[i]);
      const m = d && d.mapping && d.mapping.mapping;
      if (!m || m.oneofKind !== "partyToParticipant") throw Refusal("it is not a hosting change");
      const ptp = m.partyToParticipant;
      if (ptp.party !== party) throw Refusal("it changes hosting for another party");
      for (const p of ptp.participants || []) {
        if (!allowed.has(p.participantUid)) throw Refusal("it names a node the venue did not list (" + String(p.participantUid).slice(0, 30) + ")");
      }
    }
    return { ok: true };
  }
  const atobAny = (s) => (typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary"));
  const b64 = (u8) => {
    if (typeof btoa === "function") { let s = ""; u8.forEach((c) => { s += String.fromCharCode(c); }); return btoa(s); }
    return Buffer.from(u8).toString("base64");
  };

  return { verifyPrepared, verifyTopology };
});
