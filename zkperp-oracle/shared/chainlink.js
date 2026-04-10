import { ethers } from "ethers";
import { AGGREGATOR_V3_ABI } from "./abi.js";

/**
 * Read the latest round data from a Chainlink V3 aggregator proxy.
 * Always use the proxy address (from markets.json), never the underlying aggregator.
 */
export async function readChainlinkFeed(rpcUrl, feedAddress) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const feed = new ethers.Contract(feedAddress, AGGREGATOR_V3_ABI, provider);

  const [decimals, description, roundData] = await Promise.all([
    feed.decimals(),
    feed.description(),
    feed.latestRoundData()
  ]);

  const [roundId, answer, startedAt, updatedAt, answeredInRound] = roundData;

  if (answer <= 0n) throw new Error(`[Chainlink] Invalid answer <= 0 for ${feedAddress}`);
  if (updatedAt === 0n) throw new Error(`[Chainlink] updatedAt = 0 for ${feedAddress}`);

  return {
    decimals: Number(decimals),
    description: String(description),
    roundId: roundId.toString(),
    answer: answer.toString(),
    startedAt: startedAt.toString(),
    updatedAt: updatedAt.toString(),
    answeredInRound: answeredInRound.toString()
  };
}

/**
 * Normalise any Chainlink feed price to 8 decimal places (u128-safe integer string).
 */
export function normalizeTo8(answer, feedDecimals) {
  const value = BigInt(answer);
  if (feedDecimals === 8) return value.toString();
  if (feedDecimals > 8) return (value / 10n ** BigInt(feedDecimals - 8)).toString();
  return (value * 10n ** BigInt(8 - feedDecimals)).toString();
}
