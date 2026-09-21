// PartyLayer's SDK, re-exported so esbuild can hang it off a global.
//
// Why this and not our own adapters: PartyLayer ships per-wallet adapters
// (Loop, Console, Cantor8, Nightly, Send, Bron) plus generic announce/discovery
// ones. The per-wallet part is the point -- Console alone cost us a bespoke
// adapter, a prebundle and a corrected export name, and there are seven more
// wallets behind it. It enumerates wallets precisely because generic
// `canton:announceProvider` discovery does not catch them all.
//
// `adapter-loop` matters most here: 5North's validator has already vetted umbra,
// so a Loop party has both halves -- connectivity and vetting -- and should be
// able to trade today without asking any vendor for anything.
export {
  createPartyLayer,
  PartyLayerClient,
  getBuiltinAdapters,
  LoopAdapter,
  ConsoleAdapter,
  Cantor8Adapter,
  NightlyAdapter,
  SendAdapter,
  BronAdapter,
  GenericAnnounceAdapter,
  GenericDiscoveryAdapter,
  CANTON_NETWORKS,
  CIP0103_METHODS,
} from "@partylayer/sdk";

// Two adapters PartyLayer publishes separately rather than bundling into the
// SDK, so neither arrives with the export list above.
//
// WalletConnect is the wider of the two: it is a transport, not a single
// wallet, so it reaches every mobile wallet that speaks the protocol rather
// than one vendor's extension. We already carried @walletconnect/sign-client
// as a build dependency -- this is the adapter that actually uses it.
export { WalletConnectAdapter } from "@partylayer/adapter-walletconnect";

// OneSwap ships its own CIP-0103 adapter rather than living in PartyLayer's
// registry. It is a Canton AMM, so its users already hold the assets a block
// trade needs.
export {
  OneSwapProviderAdapter,
  createOneSwapProviderAdapter,
} from "@oneswap/wallet-cip0103-adapter";
