/**
 * @package @hazbase/smartwallet
 * SmartWallet core implementation (v0.0.1)
 *
 *   - This module provides a lightweight Smart Wallet (ERC-4337 Account Abstraction) helper with:
 *   - SmartWallet.connect(...) factory that auto-detects chain defaults
 *   - A fluent UserOp builder (execute(...).withGasLimits(...).buildAndSend())
 *   - Bundler / Provider wiring (with X-Api-Key support via ethers FetchRequest)
 *   - Optional Paymaster middleware hook (gas-sponsored flow)
 *
 * IMPORTANT
 * - Nonce is read from EntryPoint.getNonce(sender, 0) to avoid collisions with other keys.
 * - This class signs userOps with the owner EOA and submits them to a Bundler via JSON-RPC.
 */

import {
  AbstractSigner,
  BytesLike,
  TypedDataDomain,
  TypedDataField,
  TransactionRequest,
  TransactionResponse,
  TransactionReceipt,
  Signer,
  Provider,
  Interface,
  AbiCoder,
  concat,
  ethers,
  Log,
  keccak256,
  FetchRequest
} from "ethers";

import { ENTRYPOINT_ABI } from "./abis/entrypoint"
import { BASE_BUNDLER_URL, DEFAULT_ENTRYPOINT, DEFAULT_FACTORY, DEFAULT_PAYMASTER_URL, DEFAULT_PROVIDER } from "./constants";

/*************************
 * Type aliases & helpers *
 *************************/
/**
 * EVM address string (0x-prefixed, 20 bytes)
 */
export type Address = string;
/**
 * 32-byte hash string (0x-prefixed)
 */
export type Hash = string;

/*************************
 * ERC-4337 UserOperation *
 *************************/
/**
 * Canonical ERC-4337 UserOperation payload.
 * Fields must be ABI-encoded as specified in the EntryPoint contract.
 */
export type UserOperation = {
  sender: Address;
  nonce: bigint | string;
  initCode: BytesLike;
  callData: BytesLike;
  callGasLimit: bigint | string;
  verificationGasLimit: bigint | string;
  preVerificationGas: bigint | string;
  maxFeePerGas: bigint | string;
  maxPriorityFeePerGas: bigint | string;
  paymasterAndData: BytesLike;
  signature: BytesLike;
};

/******************
 * Middleware API *
 ******************/
/**
 * Middleware hooks to augment a UserOperation lifecycle.
 * - beforeSign: mutate the userOp before it is hashed/signed (e.g., inject paymasterAndData)
 * - afterSend : observe the resulting userOp hash after submission to the bundler
 */
export interface Middleware {
  /**
   * Hook executed right before the userOp is signed.
   * @param uo UserOperation object to be signed (can be mutated in place).
   */
  beforeSign?(uo: UserOperation): Promise<void>;
  /**
   * Hook executed right after eth_sendUserOperation returns.
   * @param hash UserOperation hash returned by the Bundler.
   */
  afterSend?(hash: Hash): Promise<void>;
}

/************************
 * SmartWallet Config   *
 ************************/
/**
 * Configuration required to construct a SmartWallet instance.
 * Most defaults are chain-aware and auto-filled by connect(...).
 */
export type SmartWalletConfig = {
  owner: Signer;              // EOA owner of the SmartAccount (must carry a Provider)
  factory: Address;           // AccountFactory contract address (auto-resolved in connect)
  entryPoint: Address;        // EntryPoint contract address (DEFAULT_ENTRYPOINT fallback)
  bundlerUrl: string;         // Bundler JSON-RPC endpoint (will be suffixed with /{chainId})
  salt?: bigint;              // create2 salt for account derivation (default 0n)
  middlewares?: Middleware[]; // Optional pipeline hooks executed around signing/sending
  usePaymaster?: boolean;     // If true, a default paymaster middleware is installed
  apiKey?: string;            // X-Api-Key for bundler gateway
  provider?: string;          // Public RPC for reads (DEFAULT_PROVIDER fallback)
};

/****************************************
 * UserOpBuilder — fluent UserOp helper *
 ****************************************/
/**
 * A tiny fluent helper to build/send a single user operation:
 *   wallet.execute(to, value, data)
 *         .withGasLimits({ call, verification, preVerification })
 *         .build()        // returns raw UserOperation (unsigned)
 *         .buildAndSend() // signs + sends via bundler, returns tx hash
 *
 * NOTE
 * - Gas defaults are conservative for safety; adjust with withGasLimits().
 * - Nonce is pulled from EntryPoint.getNonce(..., 0).
 */
class UserOpBuilder {
  private gas: Partial<Pick<UserOperation,
    "callGasLimit" | "verificationGasLimit" | "preVerificationGas">> = {};

  constructor(
    private readonly wallet: SmartWallet,
    private readonly to: Address,
    private readonly value: bigint,
    private readonly data: BytesLike,
  ) {}

  /**
   * Override gas limits for this userOp.
   * @param limits.call           callGasLimit (wei units; bigint)
   * @param limits.verification   verificationGasLimit (wei units; bigint)
   * @param limits.preVerification preVerificationGas (wei units; bigint)
   * @returns this (fluent)
   */
  withGasLimits(limits: Partial<{ call: bigint; verification: bigint; preVerification: bigint }>) {
    if (limits.call) this.gas.callGasLimit = limits.call;
    if (limits.verification) this.gas.verificationGasLimit = limits.verification;
    if (limits.preVerification) this.gas.preVerificationGas = limits.preVerification;
    return this;
  }

  /**
   * Build a raw unsigned UserOperation.
   * It encodes SmartAccount.execute(address,uint256,bytes) as callData.
   * Nonce is fetched from EntryPoint to avoid collisions.
   * @returns UserOperation (unsigned; paymasterAndData/signature are placeholders)
   */
  async build(): Promise<UserOperation> {
    const sender = await this.wallet.address();

    // encode execute(address,uint256,bytes)
    const callData = concat([
      "0xb61d27f6", // function selector
      AbiCoder.defaultAbiCoder().encode(["address", "uint256", "bytes"], [this.to, this.value, this.data]),
    ]);

    const hex = (v: any) => {
      if(typeof v === 'bigint') return ethers.toBeHex(v);
      return v;
    }

    const nonce = await this.wallet.getNonce()
    const uo: UserOperation = {
      sender,
      nonce: hex(nonce),
      initCode: "0x",
      callData,
      callGasLimit: hex(this.gas.callGasLimit ?? 1_500_000n),
      verificationGasLimit: hex(this.gas.verificationGasLimit ?? 1_000_000n),
      preVerificationGas: hex(this.gas.preVerificationGas ?? 100_000n),
      maxFeePerGas: hex(10n ** 9n * 25n),
      maxPriorityFeePerGas: hex(10n ** 9n * 2n),
      paymasterAndData: "0x",
      signature: "0x",
    };
    return uo;
  }

  /**
   * Build + sign + send this UserOperation to the bundler.
   * @returns Promise<Hash> userOp hash (and returns tx hash after wait in SmartWallet.send)
   */
  async buildAndSend(): Promise<Hash> {
    const uo = await this.build();
    return this.wallet.send(uo);
  }
}

/*******************************
 * SmartWallet main class      *
 *******************************/
/**
 * SmartWallet
 * - High-level facade over ERC-4337 flow:
 *   - connect(...) to construct safely
 *   - address()/isDeployed()/createAccount() for factory-based account
 *   - deposit()/getDeposit()/withdraw() to manage EntryPoint deposit
 *   - execute()/transferERC20() to compose calls
 *   - sign()/send()/wait() for the core UserOperation pipeline
 *   - asSigner() to adapt into an ethers-compatible Signer facade
 */
export class SmartWallet {
  private readonly owner: Signer;
  readonly bundler: ethers.JsonRpcProvider;
  readonly provider: ethers.JsonRpcProvider;
  private _address?: Promise<Address>;

  /**
   * Internal constructor. Use SmartWallet.connect(...) instead.
   * @param cfg Resolved config with defaults applied (middlewares always defined).
   */
  private constructor(private readonly cfg: Required<Omit<SmartWalletConfig, "middlewares" | "usePaymaster">> & { middlewares: Middleware[] }) {
    this.owner = cfg.owner;

    // Prepare Bundler provider with API key header if provided.
    const req = new FetchRequest(cfg.bundlerUrl);
    req.setHeader("X-Api-Key", cfg.apiKey);
    this.bundler = new ethers.JsonRpcProvider(req);

    // Public read-only provider for on-chain reads (non-bundler RPC).
    this.provider = new ethers.JsonRpcProvider(cfg.provider);
  }

  /**
   * Construct SmartWallet with chain-aware defaults.
   *
   * Behavior:
   * - Reads chainId from cfg.owner.provider
   * - Resolves factory / entryPoint / provider from defaults
   * - Suffixes bundlerUrl with "/{chainId}" to route by network
   * - Installs default paymaster middleware when usePaymaster is true
   *
   * @param cfg SmartWalletConfig (owner must include a Provider)
   * @returns SmartWallet instance (ready to use)
   * @throws if signer has no provider or chain not supported by DEFAULT_FACTORY
   */
  static async connect(cfg: SmartWalletConfig): Promise<SmartWallet> {
    let factoryAddress = cfg.factory;
    
    const provider = cfg.owner.provider;
    if (!provider) throw new Error('Signer must have a provider');
    
    const chainId = Number((await provider.getNetwork()).chainId);
    factoryAddress = DEFAULT_FACTORY[chainId];
    if (!factoryAddress) throw new Error('sorry your chain not supported yet.');

    const bundlerUrl = (cfg.bundlerUrl ?? BASE_BUNDLER_URL) + '/' + chainId

    const mergedCfg = {
      owner: cfg.owner,
      factory: factoryAddress,
      entryPoint: cfg.entryPoint ?? DEFAULT_ENTRYPOINT,
      bundlerUrl,
      apiKey: cfg.apiKey ?? "",
      salt: cfg.salt ?? 0n,
      middlewares: cfg.usePaymaster ? cfg.middlewares ?? [
        paymasterMiddleware(DEFAULT_PAYMASTER_URL, chainId)
      ] : [],
      provider: DEFAULT_PROVIDER[chainId] ?? ''
    } as const;

    const sw = new SmartWallet(mergedCfg);

    // Non-blocking deployment hint
    sw.isDeployed().then((dep) => {
      if (!dep) console.warn("WARN: this smart account not deployed yet.");
    });

    return sw;
  }

  /**
   * Get the SmartAccount address (predicts if not deployed).
   * Uses factory.predictAddress(owner, salt).
   * @returns Promise<Address> smart account predicted/deployed address
   */
  async address(): Promise<Address> {
    if (!this._address) {
      const factory = new ethers.Contract(
        this.cfg.factory,
        ["function predictAddress(address,uint256) view returns (address)"],
        this.owner,
      );
      this._address = factory.predictAddress(await this.owner.getAddress(), this.cfg.salt ?? 0n);
    }
    return this._address;
  }

  /**
   * Check whether the SmartAccount is already deployed.
   * Relies on factory.usedKey(keccak256(abi.encode(owner, salt))).
   * @returns Promise<boolean> true if already deployed
   */
  async isDeployed(): Promise<boolean> {
    const factory = new ethers.Contract(
      this.cfg.factory,
      ["function usedKey(bytes32) view returns (bool)"],
      this.owner,
    );
    const key = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["address", "uint256"],
        [await this.owner.getAddress(), this.cfg.salt ?? 0n]
      )
    );
    return await factory.usedKey(key);
  }

  /**
   * Deploy the SmartAccount via factory.createAccount(owner, salt).
   * @returns Promise<TransactionReceipt> deployment transaction receipt
   * @throws if already deployed
   */
  async createAccount(): Promise<TransactionReceipt> {
    if (await this.isDeployed()) {
      throw new Error("SmartAccount already deployed");
    }
    const factory = new ethers.Contract(
      this.cfg.factory,
      ["function createAccount(address,uint256) returns(address)"],
      this.owner
    );
    const tx = await factory.createAccount(await this.cfg.owner.getAddress(), this.cfg.salt);
    return await tx.wait();
  }

  /**
   * Deposit native token (ETH on EVM) into EntryPoint for this SmartAccount.
   * @param amount bigint | string | number (ether value; string/number will be parsed via parseEther)
   * @returns Promise<TransactionReceipt> deposit transaction receipt
   */
  async deposit(amount: bigint | string | number): Promise<TransactionReceipt> {
    const wei: bigint = typeof amount === "bigint" ? amount : ethers.parseEther(amount.toString());
    const ep = new ethers.Contract(
      this.cfg.entryPoint,
      ["function depositTo(address) payable"],
      this.owner
    );
    const tx = await ep.depositTo(await this.address(), { value: wei });
    return await tx.wait();
  }

  /**
   * Read current EntryPoint deposit (wei).
   * Tries balanceOf (v0.6+), falls back to deposits mapping for older versions.
   * @returns Promise<bigint> deposit in wei
   */
  async getDeposit(): Promise<bigint> {
    const ep = new ethers.Contract(
      this.cfg.entryPoint,
      ["function balanceOf(address) view returns(uint256)", // v0.6+
       "function deposits(address) view returns(uint112)"   // fallback old
      ],
      this.provider
    );
    try {
      return (await ep.balanceOf(await this.address())) as bigint;
    } catch {
      return (await ep.deposits(await this.address())) as bigint;
    }
  }

  /**
   * Withdraw deposit from EntryPoint to an external address via a user operation.
   * Encodes EntryPoint.withdrawTo(to, amount) and routes via SmartAccount.execute.
   * @param to recipient EOA/contract
   * @param amount bigint | string | number (ether value)
   * @returns Promise<Hash> user operation hash (tx hash returned by send() after wait)
   */
  async withdraw(to: Address, amount: bigint | string | number): Promise<Hash> {
    const wei: bigint = typeof amount === "bigint" ? amount : ethers.parseEther(amount.toString());
    const epIface = new Interface(["function withdrawTo(address payable,uint256)"]);
    const data    = epIface.encodeFunctionData("withdrawTo", [to, wei]);
    return await this.execute(this.cfg.entryPoint, 0n, data).withGasLimits({ call: 100_000n }).buildAndSend();
  }

  /**
   * Read EntryPoint nonce for this SmartAccount (key=0 by default).
   * @param key uint192 index (defaults to 0n)
   * @returns Promise<bigint> current nonce value
   */
  async getNonce(key: bigint = 0n): Promise<bigint> {
    const ep = new ethers.Contract(
      this.cfg.entryPoint,
      ["function getNonce(address,uint192) view returns(uint256)"],
      this.provider,
    );
    const sender = await this.address();
    const nonce: bigint = await ep.getNonce(sender, key);
    return nonce;
  }

  // --------- High-level helpers ----------
  /**
   * Compose a SmartAccount.execute(to, value, data) as a UserOp builder.
   * @param to   target contract/EOA
   * @param value native token amount (wei)
   * @param data  calldata for target
   * @returns UserOpBuilder (fluent)
   */
  execute(to: Address, value: bigint, data: BytesLike) {
    return new UserOpBuilder(this, to, value, data);
  }

  /**
   * Convenience: ERC20 transfer via execute(token, 0, transfer(to, amount)).
   * @param token  ERC20 contract address
   * @param to     recipient
   * @param amount token amount (uint256)
   * @returns UserOpBuilder (fluent)
   */
  transferERC20(token: Address, to: Address, amount: bigint) {
    const iface = new Interface(["function transfer(address,uint256)"]);
    const data = iface.encodeFunctionData("transfer", [to, amount]);
    return this.execute(token, 0n, data);
  }

  // --------- Core pipeline ---------------
  /**
   * Sign a UserOperation with the owner EOA after running middlewares.
   * The signature is ABI-encoded as (bytes sig, bytes placeholder) to keep layout extensible.
   * @param uo user operation (will be mutated to include `signature`)
   * @returns Promise<UserOperation> signed user operation
   */
  async sign(uo: UserOperation): Promise<UserOperation> {
    // middleware: beforeSign
    for (const mw of this.cfg.middlewares ?? []) {
      if (mw.beforeSign) await mw.beforeSign(uo);
    }

    const ep = new ethers.Contract(
      this.cfg.entryPoint,
      ENTRYPOINT_ABI,
      this.provider,
    );

    const hash: string = await ep.getUserOpHash(uo);
    const sig = await this.owner.signMessage(ethers.getBytes(hash));
    uo.signature = AbiCoder.defaultAbiCoder().encode(["bytes", "bytes"], [sig, "0x"]);
    return uo;
  }

  /**
   * Sign and submit a UserOperation to the bundler, then wait for inclusion.
   * - Calls sign(uo) → eth_sendUserOperation(signed, entryPoint)
   * - Polls eth_getUserOperationReceipt until found or timeout
   * - Runs afterSend middlewares
   * @param uo Unsigned user operation (will be cloned internally)
   * @returns Promise<Hash> transaction hash from the inclusion receipt
   */
  async send(uo: UserOperation): Promise<Hash> {
    const signed = await this.sign({ ...uo });

    console.log('send', signed)

    const hash: Hash = await this.bundler.send("eth_sendUserOperation", [signed, this.cfg.entryPoint]);
    
    const receipt: Log = await this.wait(hash);
    // middleware: afterSend
    for (const mw of this.cfg.middlewares ?? []) {
      if (mw.afterSend) await mw.afterSend(hash);
    }
    return receipt?.transactionHash;
  }

  /**
   * Poll for a UserOperation receipt from the bundler.
   * @param hash        userOp hash
   * @param intervalMs  polling interval in ms (default 500)
   * @param maxAttempts max attempts before giving up (default 30)
   * @returns Promise<Log> inclusion log (contains transactionHash)
   * @throws if not found within retry limit
   */
  async wait(hash: Hash, intervalMs = 500, maxAttempts = 30): Promise<Log> {
    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.bundler.send("eth_getUserOperationReceipt", [hash])
      if (response) return response.receipt;

      await new Promise((res) => setTimeout(res, intervalMs));
    }
    throw new Error("UserOperation receipt not found within retry limit");
  }

  /**
   * Return a Signer-compatible adapter that routes sendTransaction(...) via userOps.
   * @param provider Optional ethers Provider (fallbacks to owner's provider)
   * @returns SmartAccountSigner implementing AbstractSigner
   */
  asSigner(provider?: Provider | null): SmartAccountSigner {
    return new SmartAccountSigner(this, provider ?? this.owner.provider ?? null);
  }

  /**
   * Expose the underlying owner Signer as-is.
   * @returns Signer (EOA) that owns this SmartAccount
   */
  getOwner(): Signer {
    return this.owner;
  }
}

/****************************************************
 * SmartAccountSigner — AbstractSigner implementation
 ****************************************************/
/**
 * SmartAccountSigner
 * - Wraps SmartWallet into an ethers AbstractSigner so existing tooling works:
 *   - getAddress(): returns SmartAccount address
 *   - sendTransaction(tx): encodes call via userOp pipeline, returns a faux TransactionResponse
 *   - signMessage/signTypedData: delegated to the owner EOA
 *
 * Limitations:
 * - signTransaction is unsupported (AA flow does not produce raw L1 tx signed by SmartAccount).
 */
class SmartAccountSigner extends AbstractSigner {
  constructor(private readonly wallet: SmartWallet, provider: Provider | null) {
    super(provider);
  }

  /**
   * @returns Promise<Address> the SmartAccount address
   */
  async getAddress(): Promise<Address> {
    return this.wallet.address();
  }

  /**
   * Delegate message signing to the underlying owner EOA.
   * @param message arbitrary bytes to sign
   * @returns Promise<string> ECDSA signature
   */
  async signMessage(message: BytesLike): Promise<string> {
    return this.wallet.getOwner().signMessage(message);
  }

  /**
   * Delegate EIP-712 signing to the owner if supported by its Signer implementation.
   * @param domain EIP-712 domain
   * @param types  EIP-712 types
   * @param value  EIP-712 value
   * @returns Promise<string> EIP-712 signature
   * @throws if owner Signer does not implement signTypedData
   */
  async signTypedData(domain: TypedDataDomain, types: Record<string, Array<TypedDataField>>, value: Record<string, any>): Promise<string> {
    // delegate to owner if supported
    const owner: any = this.wallet.getOwner();
    if (typeof owner.signTypedData === "function") {
      return owner.signTypedData(domain, types, value);
    }
    throw new Error("Owner signer does not implement signTypedData");
  }

  /**
   * Not supported in AA context — use sendTransaction() that creates a userOp.
   * @throws always
   */
  async signTransaction(_: TransactionRequest): Promise<string> {
    throw new Error("SmartAccountSigner: signTransaction is unsupported. Use sendTransaction().");
  }

  /**
   * Send a pseudo-transaction by wrapping into a UserOperation:
   * - Builds and sends a userOp (execute(to, value, data))
   * - Returns a minimal TransactionResponse with hash + wait()
   * @param tx TransactionRequest (to, value, data are used)
   * @returns Promise<TransactionResponse> minimal response with wait()
   */
  async sendTransaction(tx: TransactionRequest): Promise<TransactionResponse> {
    const to = tx.to as Address;
    const value = BigInt(tx.value ?? 0);
    const data = tx.data ?? "0x";

    const uoHash = await this.wallet.execute(to, value, data).buildAndSend();

    const resp: TransactionResponse = {
      hash: uoHash,
      from: await this.getAddress(),
      wait: async (c: number = 1) => this.wallet.wait(uoHash, c),
    } as unknown as TransactionResponse;

    return resp;
  }

  /**
   * Return a new SmartAccountSigner bound to a specific provider (or null).
   * @param provider ethers Provider or null
   * @returns Signer
   */
  connect(provider: Provider | null): Signer {
    return new SmartAccountSigner(this.wallet, provider);
  }
}

export const paymasterMiddleware = (url: string, chainId: number): Middleware => ({
  async beforeSign(uo: UserOperation) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userOp: uo, chainId }),
    });
    const resJson = await res.json();
    uo.paymasterAndData = resJson?.data?.paymasterAndData;
  },
});
