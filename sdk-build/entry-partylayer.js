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
