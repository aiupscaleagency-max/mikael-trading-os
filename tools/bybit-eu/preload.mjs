// Preload för bybit-cli: skriver om api.bybit.com → api.bybit.eu (Bybit EU).
// Bybits CLI har bara mainnet/testnet inbyggt. Manifest-kollen (verify) får gå till .com.
const orig = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.bybit.com/") && !url.includes("/ai-manifest/")) {
    url = "https://api.bybit.eu/" + url.slice("https://api.bybit.com/".length);
    input = typeof input === "string" || input instanceof URL ? url : new Request(url, input);
  }
  return orig(input, init);
};
