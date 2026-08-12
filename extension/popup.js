/* Flax popup — wallet engine + UI */
"use strict";

// ───────────────────────────────────────── helpers
const $ = (id) => document.getElementById(id);
const XRPL_EXPLORER = "https://testnet.xrpl.org/transactions/";
const EVM_EXPLORER = "https://coston2-explorer.flare.network/tx/";
const EVM_ADDR_EXPLORER = "https://coston2-explorer.flare.network/address/";

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2000);
}

function show(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(viewId).classList.add("active");
}

/** "12.5" → 12500000n drops (6 dp), null if invalid */
function parseXrp(str) {
  if (!/^\d+(\.\d{0,6})?$/.test((str || "").trim())) return null;
  const [i, f = ""] = str.trim().split(".");
  return BigInt(i) * 1000000n + BigInt((f + "000000").slice(0, 6));
}
function fmtXrp(drops, maxDec = 6) {
  drops = BigInt(drops);
  const neg = drops < 0n; if (neg) drops = -drops;
  const i = drops / 1000000n, f = (drops % 1000000n).toString().padStart(6, "0");
  let dec = f.slice(0, maxDec).replace(/0+$/, "");
  return (neg ? "-" : "") + i.toLocaleString("en-US") + (dec ? "." + dec : "");
}
/** wei (1e18/XRP) → string with fixed decimals, for the live yield counter */
function fmtXrpWei(wei, dec = 9) {
  wei = BigInt(wei);
  const i = wei / 10n ** 18n;
  const f = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, dec);
  return i.toString() + "." + f;
}
const short = (s, a = 8, b = 6) => s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s;

function copy(text, label = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast(label));
}

const store = {
  get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
  set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  clear: () => new Promise((r) => chrome.storage.local.clear(r)),
};

// ───────────────────────────────────────── state
const S = {
  client: null,
  wallet: null,          // xrpl.Wallet
  ledgerDrops: 0n,       // on-ledger balance
  reserveDrops: 1200000n,
  yield: null,           // { principalWei, pendingWei, yieldedDrops, ... }
  activity: [],
  tick: null,            // { baseWei, principalWei, t0 }
  yieldMode: "enable",   // enable | add | withdraw
};

const spendable = () => { const s = S.ledgerDrops - S.reserveDrops - 20n; return s > 0n ? s : 0n; };
const yieldedDrops = () => (S.yield ? S.yield.yieldedDrops : 0n);
const accruedWeiNow = () => {
  if (!S.tick) return 0n;
  const dt = BigInt(Math.floor((Date.now() - S.tick.t0) / 1000));
  return S.tick.baseWei + (S.tick.principalWei * 520n * dt) / (10000n * 31536000n);
};

// ───────────────────────────────────────── xrpl connection
async function connect() {
  if (S.client?.isConnected()) return S.client;
  S.client = new xrpl.Client(FCC.CONFIG.XRPL_WSS);
  await S.client.connect();
  FCC.init(S.client);
  try {
    const si = await S.client.request({ command: "server_info" });
    const v = si.result.info.validated_ledger;
    if (v) S.reserveDrops = BigInt(Math.round((v.reserve_base_xrp + v.reserve_inc_xrp) * 1e6)) + 100000n;
  } catch {}
  return S.client;
}

async function fetchLedgerBalance() {
  try {
    const r = await S.client.request({ command: "account_info", account: S.wallet.address, ledger_index: "validated" });
    S.ledgerDrops = BigInt(r.result.account_data.Balance);
  } catch (e) {
    S.ledgerDrops = 0n; // not activated yet
  }
}

async function refreshYield() {
  try {
    S.yield = await FCC.getYieldState(S.wallet.address);
    S.tick = { baseWei: S.yield.pendingWei, principalWei: S.yield.principalWei, t0: Date.now() };
  } catch (e) {
    console.warn("yield state fetch failed", e);
  }
}

