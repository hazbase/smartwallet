# @hazbase/smartwallet
[![npm version](https://badge.fury.io/js/%40hazbase%2Fsmartwallet.svg)](https://badge.fury.io/js/%40hazbase%2Fsmartwallet)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## Overview
`@hazbase/smartwallet` is a **lightweight helper** to work with **ERC‑4337** Smart Accounts using minimal code.

**Highlights**
- Chain‑aware `SmartWallet.connect(...)` that auto‑fills defaults (Factory / EntryPoint / Provider)
- Fluent **UserOperation builder**: `execute(...).withGasLimits(...).buildAndSend()`
- **Bundler integration** with `X-Api-Key` header and path‑based routing (`https://<host>/<chainId>`)
- Optional **Paymaster middleware** to inject `paymasterAndData`
- **Signer adapter**: `asSigner()` exposes an ethers‑compatible `AbstractSigner`

---

## Requirements
- **Node.js**: 18+
- **ethers**: v6 (uses `JsonRpcProvider` and `FetchRequest`)
- Bundler must implement `eth_sendUserOperation` and `eth_getUserOperationReceipt` (and optionally route by `/chainId`).
- (Optional) **Paymaster API** that accepts `POST { userOp, chainId }` and returns `{ data: { paymasterAndData } }`.

---

## Installation
```bash
npm i @hazbase/smartwallet ethers
```

---

## Configuration
This package expects explicit configuration in code (it does **not** read `.env`).

- `bundlerUrl`: e.g., `https://bundler.example.com` (the library appends `/{chainId}` internally)
- `apiKey`: value for the `X-Api-Key` header sent to your bundler
- `owner`: an ethers `Signer` with a connected `Provider`
- `entryPoint` / `factory` / `provider`: resolved by `connect()` per chain; throws if unsupported

---

## Quick start

### 1) Minimal call via UserOperation
```ts
import { ethers } from "ethers";
import { SmartWallet } from "@hazbase/smartwallet";

async function main() {
  // 1) Prepare owner signer with a provider
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL!);
  const owner = new ethers.Wallet(process.env.OWNER_KEY!, provider);

  // 2) Connect SmartWallet (factory/entryPoint/provider are auto-filled by chainId)
  const sw = await SmartWallet.connect({
    owner,
    factory    : "0x0",                      // placeholder (auto-resolved)
    entryPoint : "0x0",                      // placeholder (auto-resolved)
    bundlerUrl : "https://bundler.example.com",
    apiKey     : process.env.BUNDLER_API_KEY || "",
    usePaymaster: false
  });

  // 3) Send a 0 ETH call (or set a real value)
  const to = "0x000000000000000000000000000000000000dEaD";
  const value = 0n;
  const data = "0x";                         // empty calldata

  // Build & send → returns tx hash after inclusion
  const txHash = await sw.execute(to, value, data)
                          .withGasLimits({ call: 200_000n })
                          .buildAndSend();

  console.log("txHash:", txHash);
}

main().catch(console.error);
```

### 2) ERC‑20 transfer
```ts
import { SmartWallet } from "@hazbase/smartwallet";

async function transferErc20(sw: SmartWallet, token: string, to: string, amount: bigint) {
  const txHash = await sw.transferERC20(token, to, amount).buildAndSend();
  console.log("erc20 transfer txHash:", txHash);
}
```

### 3) Gas‑sponsored flow with a Paymaster (optional)
```ts
import { SmartWallet, paymasterMiddleware } from "@hazbase/smartwallet";

const chainId = 11155111; // sepolia
const sw = await SmartWallet.connect({
  owner,
  factory    : "0x0",
  entryPoint : "0x0",
  bundlerUrl : "https://bundler.example.com",
  apiKey     : process.env.BUNDLER_API_KEY || "",
  usePaymaster: true,                         // enable default
  middlewares: [
    paymasterMiddleware("https://paymaster.example.com", chainId)
  ]
});
```

### 4) Use as an ethers Signer
```ts
import { ethers } from "ethers";

const signer = sw.asSigner(); // AbstractSigner-compatible

const resp = await signer.sendTransaction({
  to: "0x000000000000000000000000000000000000dEaD",
  value: 0n,
  data: "0x"
});

console.log("userOp hash:", resp.hash);
const receipt = await resp.wait(1); // internally polls eth_getUserOperationReceipt
console.log("included tx:", receipt.transactionHash);
```

---

## Routing & Headers (Bundler)
- The library requests `bundlerUrl + "/" + chainId`:
  - e.g., `https://bundler.example.com/11155111`
  - e.g., `https://bundler.example.com/80002`
- If `apiKey` is provided, requests include `X-Api-Key: <your-key>` automatically.

---

## Public API (selected)

### `SmartWallet.connect(cfg: SmartWalletConfig): Promise<SmartWallet>`
- **Role**: Construct a wallet with chain defaults (Factory / EntryPoint / Provider), route bundler by `/{chainId}`, and attach middlewares.
- **Args**
  - `owner: Signer` (**must have Provider**)
  - `bundlerUrl: string` (e.g., `https://bundler.example.com`)
  - `apiKey?: string` (adds `X-Api-Key` header)
  - `usePaymaster?: boolean` / `middlewares?: Middleware[]`
  - `factory? / entryPoint? / provider?` (optional; will be auto‑resolved per chain)
- **Returns**: `SmartWallet`

### `address(): Promise<Address>`
- **Role**: Predict (or return) the SmartAccount address via `factory.predictAddress(owner, salt)`.
- **Returns**: `Address`

### `isDeployed(): Promise<boolean>`
- **Role**: Check if the account is deployed using `factory.usedKey(keccak(owner,salt))`.
- **Returns**: `boolean`

### `createAccount(): Promise<TransactionReceipt>`
- **Role**: Deploy the account via `factory.createAccount(owner,salt)`.
- **Returns**: Deployment tx receipt
- **Throws**: If already deployed

### `deposit(amount): Promise<TransactionReceipt>`
- **Role**: Deposit native token (ETH) to EntryPoint for this account (`depositTo(address)`).
- **Args**: `bigint | string | number` (`string/number` parsed via `parseEther`)
- **Returns**: Tx receipt

### `getDeposit(): Promise<bigint>`
- **Role**: Read EntryPoint deposit (uses `balanceOf`, falls back to `deposits` for older EP).
- **Returns**: `wei` balance

### `withdraw(to, amount): Promise<Hash>`
- **Role**: Execute `EntryPoint.withdrawTo(to, amount)` via a userOp.
- **Returns**: L1 tx hash after inclusion

### `getNonce(key=0n): Promise<bigint>`
- **Role**: Read `EntryPoint.getNonce(account, key)` (defaults to key=0).
- **Returns**: `nonce`

### `execute(to, value, data): UserOpBuilder`
- **Role**: Compose `SmartAccount.execute(to, value, data)` userOp.
- **Returns**: `UserOpBuilder` (`withGasLimits().build().buildAndSend()`)

### `transferERC20(token, to, amount): UserOpBuilder`
- **Role**: Shortcut to call ERC‑20 `transfer(to, amount)` via userOp.

### `sign(uo): Promise<UserOperation>`
- **Role**: Run `beforeSign` middlewares → `EntryPoint.getUserOpHash(uo)` → `owner.signMessage`.
- **Returns**: Signed `UserOperation` (signature populated)

### `send(uo): Promise<Hash>`
- **Role**: `sign()` → Bundler `eth_sendUserOperation` → `wait()` → `afterSend` middlewares.
- **Returns**: L1 tx hash once included

### `wait(hash, intervalMs=500, maxAttempts=30): Promise<Log>`
- **Role**: Poll `eth_getUserOperationReceipt` until present or timeout.
- **Returns**: Inclusion log (has `transactionHash`)
- **Throws**: If not found within the limit

### `asSigner(provider?): SmartAccountSigner`
- **Role**: Return an ethers `AbstractSigner` to integrate with existing tooling.

### `getOwner(): Signer`
- **Role**: Expose the underlying EOA signer.

---

## Troubleshooting
- **`AA23 reverted: deposit fail`**  
  The account or Paymaster deposit is insufficient. Top up with `depositTo(...)`.
- **`invalid paymaster signature`**  
  The `paymasterAndData` signature scheme or signer does not match the Paymaster contract.
- **UserOp receipt not found**  
  Increase `wait()` attempts or ensure the Bundler retains receipts long enough.
- **CORS** (browser usage)  
  Allow `Access-Control-Allow-*` headers on your HTTPS reverse proxy.

---

## Tips
- The library automatically sets `X-Api-Key` when `apiKey` is provided.
- L1 gas is ultimately paid by the **Account deposit** or the **Paymaster deposit**.

---

## License
Apache-2.0
