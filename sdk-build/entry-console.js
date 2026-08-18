// Console Wallet's dApp SDK, re-exported so esbuild can hang it off a global.
//
// Console's README offers a no-build path via unpkg, but it does not work in a
// browser: their ESM entry imports styles.css, and a module script served as
// text/css is rejected outright ("Expected a JavaScript-or-Wasm module script").
// esbuild inlines that CSS, so bundling is the only way to load this SDK into a
// page that has no build step of its own.
// NOTE: the README says `consoleWalletPixelplex`; the package actually exports
// `consoleWallet` (v2.2.9). Verified against dist/esm/index.d.ts, which also
// confirms prepareExecute / prepareExecuteAndWait / ledgerApi / getContracts.
export { consoleWallet } from "@console-wallet/dapp-sdk";
