export const DEFAULT_FACTORY: Record<number, string> = {
  11155111: '0x91A237A5964D2fa32d26cD3590242eA84E461BBd'
}

// Keyless public RPC fallbacks only. Never commit a provider URL that embeds an
// API key/token — anything here ships inside the published package. Callers should
// pass their own `provider` via SmartWalletConfig; connect() honors that override.
export const DEFAULT_PROVIDER: Record<number, string> = {
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com'
}

export const BASE_BUNDLER_URL: string = "https://bundler.hazbase.com";
export const DEFAULT_PAYMASTER_URL: string = "https://prd-hazbase-api.an.r.appspot.com/api/app/paymaster/paymaster-and-data";
export const DEFAULT_ENTRYPOINT: string = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789"; // v0.6 Entrypoint