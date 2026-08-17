// `node --check` cannot read HTML, and index.html carries the whole app inside
// inline <script> blocks. Extract each block and hand it to the same parser node
// would use, so a stray brace fails here instead of silently in a browser.
const fs = require("fs");
const vm = require("vm");

const file = process.argv[2] || "public/index.html";
const html = fs.readFileSync(file, "utf8");

// Only inline blocks: a <script src=...> has no body to parse.
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, n = 0, bad = 0;
while ((m = re.exec(html))) {
  n++;
  const upto = html.slice(0, m.index).split("\n").length;
  try {
    new vm.Script(m[1], { filename: `${file}:<script #${n}>` });
    console.log(`ok    block ${n} (line ${upto}, ${m[1].length} chars)`);
  } catch (e) {
    bad++;
    console.error(`FAIL  block ${n} (line ${upto}): ${e.message}`);
  }
}
console.log(`${n} inline block(s), ${bad} failed`);
process.exit(bad ? 1 : 0);
