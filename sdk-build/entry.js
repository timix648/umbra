// Everything the SDK exports, re-exported under one roof so esbuild can hang it
// all off a single global. `connect`, `listAccounts`, `prepareExecute`,
// `ledgerApi`, `DappClient`, `DiscoveryClient` and `RemoteAdapter` all arrive
// on `window.CantonDapp`.
export * from "@canton-network/dapp-sdk";
