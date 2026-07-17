#!/usr/bin/env node
/*
 * UMBRA - probe the participant's package store for the registry AllocationV1 pkg.
 * Confirms 93c942ae... is present + downloadable before we plan the v8 rebuild.
 * Run from ~/umbra:  node probe_pkg.js
 */
require("dotenv").config({ path: "backend/.env" });
const { ledgerFetch } = require("./backend/token.js");
const fs = require("fs");

const WANT = "93c942ae2b4c2ba674fb152fe38473c507bda4e82b4e4c5da55a552a9d8cce1d";

(async () => {
  // 1) list packages
  const lr = await ledgerFetch("/v2/packages");
  const lt = await lr.text();
  if (!lr.ok) { console.log("LIST FAILED", lr.status, lt.slice(0, 400)); process.exit(1); }
  let ids = [];
  try { const j = JSON.parse(lt); ids = j.packageIds || j.package_ids || j.packages || j; } catch { console.log("parse fail:", lt.slice(0,300)); }
  if (!Array.isArray(ids)) { console.log("unexpected list shape:", lt.slice(0, 400)); process.exit(1); }
  console.log("total packages on participant:", ids.length);
  const present = ids.includes(WANT);
  console.log("93c942ae present? ", present);
  if (!present) {
    console.log("first 5 package ids (for reference):");
    ids.slice(0, 5).forEach(i => console.log("  ", i));
    process.exit(0);
  }

  // 2) download it
  const dr = await ledgerFetch("/v2/packages/" + WANT);
  console.log("download status:", dr.status, dr.headers.get("content-type"));
  if (dr.ok) {
    const buf = Buffer.from(await dr.arrayBuffer());
    fs.writeFileSync("/tmp/alloc-93c942ae.dalf", buf);
    console.log("saved /tmp/alloc-93c942ae.dalf  bytes:", buf.length);
    console.log("HEAD (hex):", buf.slice(0,8).toString("hex"));
    console.log("-> we have the exact registry package. Next step: wrap into a DAR for data-dependencies.");
  } else {
    console.log("download failed:", (await dr.text()).slice(0, 400));
  }
})().catch(e => { console.log("ERR", e.message); process.exit(1); });
