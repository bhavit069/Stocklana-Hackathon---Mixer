
require("dotenv").config({ quiet: true });

const { query, close } = require("../database");
const { addToWatchlist } = require("./watcher.repo");
const { addToken } = require("../functions/newToken");
const { tokenExists } = require("./token.repo");
const { createMixer, fetchMixerById } = require("./mixer.repo");
const { addMixerAllocation } = require("./mixer_allocations.repo");

const DEMO_MIXER_ID = "DemoMixer1111111111111111111111111111111111";

const ALLOCATIONS = [
  { address: "So11111111111111111111111111111111111111112", weight: 0.4 },
  { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", weight: 0.35 },
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", weight: 0.25 }
];

async function main() {

  const users = await query("SELECT user_id FROM users ORDER BY created_at LIMIT 1");
  if (!users.length) {
    console.error("No users yet. Register at http://localhost:6900/register first.");
    process.exit(1);
  }
  const userId = users[0].user_id;
  console.log("Owner:", userId);

  for (const { address } of ALLOCATIONS) {
    if (await tokenExists(address)) {
      console.log("token_info  already present:", address.slice(0, 8));
    } else {
      const t = await addToken(address);
      console.log("token_info  created:", t ? `${t.symbol} (${address.slice(0, 8)})` : "FAILED");
    }
    await addToWatchlist(address);
    console.log("watchlist   +", address.slice(0, 8));
  }

  if (await fetchMixerById(DEMO_MIXER_ID)) {
    console.log("mixer       already exists:", DEMO_MIXER_ID);
  } else {
    await createMixer({
      mixer_id: DEMO_MIXER_ID,
      created_by: userId,
      name: "Demo Mixer",
      ticker: "DEMO",
      image: "",
      description: "Seeded dev mixer: 40% SOL / 35% JUP / 25% USDC",
      initial_price: 0,
      mixer_authority_pda: "DemoAuthority111111111111111111111111111111"
    });
    console.log("mixer       created:", DEMO_MIXER_ID);

    for (const a of ALLOCATIONS) {
      await addMixerAllocation({
        mixer_id: DEMO_MIXER_ID,
        token_address: a.address,
        vault_pda: null,
        weight: a.weight
      });
      console.log("allocation  +", a.address.slice(0, 8), a.weight);
    }
  }

  console.log("\nDone. The scraper picks this up within 60s (watchlist refresh).");
  await close();
}

main().catch(async (err) => {
  console.error(err);
  await close();
  process.exit(1);
});
