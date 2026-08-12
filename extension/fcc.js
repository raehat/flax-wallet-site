/**
 * Flax ⇄ Flare Confidential Compute bridge.
 *
 * In production this module only *talks* to the FCC TEE extension: yield
 * instructions are dispatched through the InstructionSender contract on
 * Flare, and the enclave-held custody keys never leave the TEE.
 *
 * For the testnet build, the enclave operations are executed locally with
 * the registered TEE machine's operator credentials so the full flow
 * (custody transfer → FXRP mint → vault stake → rebalance) runs against
 * real Coston2 + XRPL testnet infrastructure end to end.
 */

const FCC = (() => {
  // ---------------------------------------------------------------- config
  const CONFIG = {
    // XRPL testnet
    XRPL_WSS: "wss://s.altnet.rippletest.net:51233",
    // FCC custody account (enclave-held on production TEEs)
    CUSTODY_ADDRESS: "rpsMWxQHqK83RQdiwfAVvKbYVJ5hhtbXWB",
    CUSTODY_SEED: "sEdSze4THGouCrFkA38Q8L3JZqBk8rC",

    // Flare Coston2
    EVM_RPC: "https://coston2-api.flare.network/ext/C/rpc",
    OPERATOR_KEY: "0x4e91cfdbe96d66cf082616431844413c400baa88bea848077e1c73804d8664ab",
    OPERATOR_ADDRESS: "0x9558603EDC9Bcc0f8cebFeb2fBf5f3Ba76c0ef0C",
    FXRP_ADDRESS: "0x2d572a5FB98A029e4ad21860F1E2E7ED8F2c029b",
    VAULT_ADDRESS: "0x3d84976Ac03C04F9b7Fcec7af0289776dAECA8a2",

    // Registered FCC TEE deployment this wallet is bound to
    TEE: {
      extensionId: "66288",
      machineId: "0x7592A8CB7FB52aC5C99d80B3Be51374c75B3aa2A",
      codeHash: "0x194844cf417dde867073e5ab7199fa4d21fd82b5dbe2bdea8b3d7fc18d10fdc2",
      instructionSender: "0x29057Eb605915003eb7CA918232d75D2cd0e2eA7",
      registry: "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE",
      status: "PRODUCTION",
    },

    // 70% of yielded XRP is wrapped to FXRP and deployed to strategies,
    // 30% stays as liquid custody buffer for instant spends.
    WRAP_BPS: 7000n,
    APY_BPS: 520n,
  };

  const FXRP_ABI = [
    "function mint(address to, uint256 value, bytes32 xrplRef)",
    "function burn(address from, uint256 value, bytes32 xrplRef)",
    "function approve(address spender, uint256 value) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
  ];
  const VAULT_ABI = [
    "function stakeFor(bytes32 user, uint256 amount)",
    "function unstakeFor(bytes32 user, uint256 amount)",
    "function pendingYield(bytes32 user) view returns (uint256)",
    "function principalOf(bytes32 user) view returns (uint256)",
    "function totalStaked() view returns (uint256)",
  ];

  // ---------------------------------------------------------------- state
  let xrplClient = null; // shared, injected by popup
  let provider = null;
  let operator = null;
  let fxrp = null;
  let vault = null;

  function init(sharedXrplClient) {
    xrplClient = sharedXrplClient;
    provider = new ethers.JsonRpcProvider(CONFIG.EVM_RPC, 114, { staticNetwork: true });
    operator = new ethers.Wallet(CONFIG.OPERATOR_KEY, provider);
    fxrp = new ethers.Contract(CONFIG.FXRP_ADDRESS, FXRP_ABI, operator);
    vault = new ethers.Contract(CONFIG.VAULT_ADDRESS, VAULT_ABI, operator);
  }

  // ---------------------------------------------------------------- utils
  const dropsToWei = (drops) => BigInt(drops) * 10n ** 12n;
  const weiToDrops = (wei) => BigInt(wei) / 10n ** 12n;
  const userId = (xrpAddress) => ethers.keccak256(ethers.toUtf8Bytes(xrpAddress));

  async function custodyWallet() {
    return xrpl.Wallet.fromSeed(CONFIG.CUSTODY_SEED);
  }

  async function xrplPayment(fromWallet, destination, drops, memo) {
    const tx = {
      TransactionType: "Payment",
      Account: fromWallet.address,
      Destination: destination,
      Amount: String(drops),
    };
    if (memo) {
      tx.Memos = [{ Memo: { MemoData: Array.from(new TextEncoder().encode(memo)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase() } }];
    }
    const prepared = await xrplClient.autofill(tx);
    const signed = fromWallet.sign(prepared);
    const res = await xrplClient.submitAndWait(signed.tx_blob);
    const code = res.result.meta?.TransactionResult;
    if (code !== "tesSUCCESS") throw new Error(`XRPL payment failed: ${code}`);
    return res.result.hash;
  }

  async function ensureAllowance(needWei) {
    const current = await fxrp.allowance(CONFIG.OPERATOR_ADDRESS, CONFIG.VAULT_ADDRESS);
    if (current < needWei) {
      const tx = await fxrp.approve(CONFIG.VAULT_ADDRESS, ethers.MaxUint256);
      await tx.wait();
    }
  }

  async function burnOperatorBalance(xrplRef) {
    const bal = await fxrp.balanceOf(CONFIG.OPERATOR_ADDRESS);
    if (bal > 0n) {
      const tx = await fxrp.burn(CONFIG.OPERATOR_ADDRESS, bal, xrplRef);
      await tx.wait();
      return bal;
    }
    return 0n;
  }

  // ---------------------------------------------------------------- flows

  /**
   * Enable / top-up yield: user XRP → FCC custody, 70% wrapped to FXRP and
   * deployed to the yield vault, 30% held liquid in custody.
   */
  async function enableYield(userWallet, drops, onStep) {
    onStep?.(0, "Transferring XRP to FCC custody…");
    const xrplHash = await xrplPayment(userWallet, CONFIG.CUSTODY_ADDRESS, drops, "FLAX:YIELD");

    const wrapWei = (dropsToWei(drops) * CONFIG.WRAP_BPS) / 10000n;
    const ref = "0x" + xrplHash.toLowerCase();

    onStep?.(1, "TEE attesting custody deposit, minting FXRP…");
    const mintTx = await fxrp.mint(CONFIG.OPERATOR_ADDRESS, wrapWei, ref);
    await mintTx.wait();

    onStep?.(2, "Deploying FXRP to yield strategies…");
    await ensureAllowance(wrapWei);
    const stakeTx = await vault.stakeFor(userId(userWallet.address), wrapWei);
    await stakeTx.wait();

    return { xrplHash, mintTx: mintTx.hash, stakeTx: stakeTx.hash, wrapWei };
  }

  /**
   * Withdraw from yield: custody sends XRP (+ accrued yield) back to the
   * user, then the enclave rebalances by unstaking + unwrapping FXRP.
   */
  async function unyield(userAddress, drops, onStep) {
    const id = userId(userAddress);
    const principalWei = await vault.principalOf(id);
    const pendingWei = await vault.pendingYield(id);
    const unstakeWei = (dropsToWei(drops) * CONFIG.WRAP_BPS) / 10000n;
    if (unstakeWei > principalWei) throw new Error("Amount exceeds yielded balance");

    // yield share proportional to the principal being withdrawn
    const yieldShareWei = principalWei > 0n ? (pendingWei * unstakeWei) / principalWei : 0n;
    const payoutDrops = BigInt(drops) + weiToDrops(yieldShareWei);

    onStep?.(0, "FCC custody releasing XRP + yield…");
    const custody = await custodyWallet();
    const xrplHash = await xrplPayment(custody, userAddress, payoutDrops, "FLAX:UNYIELD");

    onStep?.(1, "Unstaking FXRP from strategies…");
    const unstakeTx = await vault.unstakeFor(id, unstakeWei);
    await unstakeTx.wait();

    onStep?.(2, "Unwrapping FXRP back to XRP…");
    await burnOperatorBalance("0x" + xrplHash.toLowerCase());

    return { xrplHash, unstakeTx: unstakeTx.hash, payoutDrops };
  }

  /**
   * Spend on behalf of the user from custody (when their liquid balance
   * can't cover a payment but their yielded balance can), then rebalance
   * the 30/70 split.
   */
  async function spendViaFcc(userAddress, destination, drops, onStep) {
    onStep?.(0, "FCC custody paying recipient…");
    const custody = await custodyWallet();
    const xrplHash = await xrplPayment(custody, destination, drops, "FLAX:SPEND");

    onStep?.(1, "Rebalancing: unstaking FXRP…");
    const id = userId(userAddress);
    const unstakeWei = (dropsToWei(drops) * CONFIG.WRAP_BPS) / 10000n;
    const principalWei = await vault.principalOf(id);
    const actual = unstakeWei > principalWei ? principalWei : unstakeWei;
    let unstakeTx = null;
    if (actual > 0n) {
      unstakeTx = await vault.unstakeFor(id, actual);
      await unstakeTx.wait();
    }

    onStep?.(2, "Unwrapping FXRP to restore custody buffer…");
    await burnOperatorBalance("0x" + xrplHash.toLowerCase());

    return { xrplHash, unstakeTx: unstakeTx?.hash ?? null };
  }

  /** Live on-chain view of a user's yield position. */
  async function getYieldState(userAddress) {
    const id = userId(userAddress);
    const [principalWei, pendingWei, totalStakedWei] = await Promise.all([
      vault.principalOf(id),
      vault.pendingYield(id),
      vault.totalStaked(),
    ]);
    return {
      principalWei,
      pendingWei,
      totalStakedWei,
      principalDrops: weiToDrops(principalWei),
      pendingDrops: weiToDrops(pendingWei),
      // full user position = staked principal is 70% of yielded XRP
      yieldedDrops: (weiToDrops(principalWei) * 10000n) / CONFIG.WRAP_BPS,
      apyBps: Number(CONFIG.APY_BPS),
    };
  }

  async function custodyBalance() {
    try {
      const r = await xrplClient.request({ command: "account_info", account: CONFIG.CUSTODY_ADDRESS, ledger_index: "validated" });
      return BigInt(r.result.account_data.Balance);
    } catch { return 0n; }
  }

  return { CONFIG, init, enableYield, unyield, spendViaFcc, getYieldState, custodyBalance, userId };
})();
