const { getToken } = require("./token.js");
(async () => {
  const base = process.env.LEDGER_API;
  const tok = await getToken();
  const live = await fetch(base + "/livez").then(r=>r.status).catch(()=>0);
  const ready = await fetch(base + "/readyz").then(r=>r.status).catch(()=>0);
  const party = process.env.REQUESTER;
  const t0 = Date.now();
  let seqStatus, seqMsg;
  try {
    const r = await fetch(base + "/v2/commands/submit-and-wait", {
      method:"POST",
      headers:{ "Content-Type":"application/json","Authorization":"Bearer "+tok },
      body: JSON.stringify({
        commandId: "seqcheck-"+Date.now(),
        actAs: [party],
        commands: [{ CreateCommand: {
          templateId: "#"+(process.env.PACKAGE_NAME||"umbra-v8")+":UmbraSwap:SwapRfq",
          createArguments: {
            requester: party, operator: party,
            offerAsset: { admin: party, symbol: "PING" }, offerAmount: "0.001",
            wantAsset: { admin: party, symbol: "PONG" }, invited: [],
            expiresAt: new Date(Date.now()+600000).toISOString()
          }
        }}]
      })
    });
    seqStatus = r.status;
    seqMsg = (await r.text()).slice(0,160);
  } catch(e){ seqStatus = "ERR"; seqMsg = e.message; }
  const ms = Date.now()-t0;
  console.log("livez:", live, "| readyz:", ready);
  console.log("submit-and-wait:", seqStatus, "in", ms+"ms");
  console.log("detail:", seqMsg);
  if (seqStatus === 200) console.log("\nSEQUENCER IS BACK - transactions committing.");
  else if (String(seqMsg).includes("timely") || String(seqMsg).includes("NOT_SEQUENCED"))
    console.log("\nSTILL DOWN - sequencer not sequencing.");
  else console.log("\nDifferent error - read detail above.");
})().catch(e=>console.log("ERR", e.message));
