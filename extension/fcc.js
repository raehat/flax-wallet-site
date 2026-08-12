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


  return { CONFIG, init, userId, custodyWallet };
})();
