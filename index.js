require('dotenv').config();
const { ethers } = require('ethers');

// ── Config (all from .env, see .env.example) ───────────────────────────────
const RPC_URL = process.env.RPC_URL || 'https://bsc-dataseed.bnbchain.org';
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const TAX_TOKEN_ADDRESS = process.env.TAX_TOKEN_ADDRESS;
const KEEPER_PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const DEPLOY_BLOCK = parseInt(process.env.DEPLOY_BLOCK || '0', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '300', 10);
const LOG_SCAN_CHUNK = 500; // blocks per eth_getLogs call — this RPC's cap is stricter than usual

if (!VAULT_ADDRESS || !TAX_TOKEN_ADDRESS || !KEEPER_PRIVATE_KEY) {
  console.error('Missing required .env values. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const VAULT_ABI = ['function distributeTo(address[] calldata users) external'];

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
];

// ── Build the current holder list by scanning Transfer events, then
//    keep only addresses with a positive balance right now ─────────────────
async function getEligibleHolders(provider) {
  const token = new ethers.Contract(TAX_TOKEN_ADDRESS, ERC20_ABI, provider);
  const latestBlock = await provider.getBlockNumber();
  const seen = new Set();

  for (let from = DEPLOY_BLOCK; from <= latestBlock; from += LOG_SCAN_CHUNK) {
    const to = Math.min(from + LOG_SCAN_CHUNK - 1, latestBlock);
    const events = await token.queryFilter(token.filters.Transfer(), from, to);
    for (const ev of events) {
      if (ev.args.to !== ethers.ZeroAddress) seen.add(ev.args.to);
    }
    console.log(`  scanned blocks ${from}-${to} (${seen.size} addresses seen so far)`);
  }

  console.log(`Checking current balances for ${seen.size} addresses...`);
  const eligible = [];
  for (const addr of seen) {
    const bal = await token.balanceOf(addr);
    if (bal > 0n) eligible.push(addr);
  }
  return eligible;
}

async function distribute() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(KEEPER_PRIVATE_KEY, provider);
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);

  console.log(`[${new Date().toISOString()}] Starting distribution run...`);

  let holders;
  if (process.env.KNOWN_HOLDERS) {
    // Skip log-scanning entirely — useful as a fallback when the RPC
    // provider rate-limits eth_getLogs, or when you already have a cached
    // holder list from an indexer/explorer.
    const candidates = process.env.KNOWN_HOLDERS.split(',').map((a) => a.trim());
    console.log(`KNOWN_HOLDERS set — skipping log scan, checking ${candidates.length} candidate addresses...`);
    const token = new ethers.Contract(TAX_TOKEN_ADDRESS, ERC20_ABI, provider);
    holders = [];
    for (const addr of candidates) {
      const bal = await token.balanceOf(addr);
      if (bal > 0n) holders.push(addr);
    }
  } else {
    console.log('Scanning holders (this can take a while on first run)...');
    holders = await getEligibleHolders(provider);
  }

  console.log(`Found ${holders.length} eligible holders.`);

  if (holders.length === 0) {
    console.log('Nothing to distribute to. Done.');
    return;
  }

  for (let i = 0; i < holders.length; i += BATCH_SIZE) {
    const batch = holders.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(holders.length / BATCH_SIZE);
    console.log(`Batch ${batchNum}/${totalBatches} (${batch.length} addresses)...`);
    try {
      const tx = await vault.distributeTo(batch);
      console.log(`  tx sent: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);
    } catch (err) {
      console.error(`  batch ${batchNum} failed:`, err.shortMessage || err.message);
      // keep going with the next batch rather than aborting the whole run
    }
  }

  console.log(`[${new Date().toISOString()}] Distribution run complete.`);
}

// ── Pick a fresh random time each day, on purpose — see chat discussion:
//    this raises the bar against casual/manual gaming, but is NOT a
//    substitute for a real holding-period defense against automated MEV bots
//    watching the mempool. Documented trade-off, not a false promise. ──────
function scheduleNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  const msUntil = next.getTime() - now.getTime();
  console.log(`Next run scheduled for ${next.toISOString()} (in ${(msUntil / 3600000).toFixed(1)}h)`);

  setTimeout(async () => {
    try {
      await distribute();
    } catch (err) {
      console.error('Distribution run failed:', err);
    }
    scheduleNextRun(); // pick a new random time for the next day
  }, msUntil);
}

console.log('Flap dividend distribution bot starting...');
console.log(`Vault: ${VAULT_ADDRESS}`);
console.log(`Tax token: ${TAX_TOKEN_ADDRESS}`);

if (process.env.RUN_ONCE === 'true') {
  console.log('RUN_ONCE=true — running a single distribution pass now, then exiting.');
  distribute()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Distribution run failed:', err);
      process.exit(1);
    });
} else {
  scheduleNextRun();
}
