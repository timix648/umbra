// Loop's SDK, bundled straight for the signature probe.
//
// Not routed through PartyLayer's LoopAdapter on purpose: the adapter's job is to
// normalise wallets onto one interface, and the probe is asking a question ABOUT
// the raw interface -- specifically what provider.signMessage() actually signs.
// One layer fewer is one layer that cannot explain away a wrong answer.
//
// Imported by relative path rather than package name: npm cannot install into this
// tree from Windows (EISDIR on node_modules/.bin across the WSL share), and the
// adapter already carries loop-sdk 0.13.4, which is npm's current `latest`.
// `dist/index.js` is the browser entry and pulls in no node-forge -- that lives
// only in dist/server/, which is a separate entry point we never touch.
export { loop } from "./node_modules/@partylayer/adapter-loop/node_modules/@fivenorth/loop-sdk/dist/index.js";
