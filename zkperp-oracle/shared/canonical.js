/**
 * Canonical payload — ALL relayers must produce the exact same JSON string
 * from the same Chainlink round. Field order is locked; do not change it.
 */
export function buildCanonicalPayload({ assetId, price, updatedAt, roundId, sourceChainId, feedAddress }) {
  return {
    assetId: String(assetId),
    price: String(price),
    updatedAt: String(updatedAt),
    roundId: String(roundId),
    sourceChainId: Number(sourceChainId),
    feedAddress: feedAddress.toLowerCase()
  };
}

/**
 * Deterministic JSON string used for signing and grouping.
 * Key order must never change.
 */
export function canonicalString(payload) {
  return JSON.stringify({
    assetId: payload.assetId,
    price: payload.price,
    updatedAt: payload.updatedAt,
    roundId: payload.roundId,
    sourceChainId: payload.sourceChainId,
    feedAddress: payload.feedAddress
  });
}
