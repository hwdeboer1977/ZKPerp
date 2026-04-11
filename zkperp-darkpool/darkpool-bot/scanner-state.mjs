// ============================================================
// scanner-state.mjs — shared scanner state, imported by both
// scanner.mjs and orderbook.mjs to avoid circular dependency
// ============================================================

let _latestChainTip   = 0
let _lastScannedBlock = 0

export function setChainTip(tip)    { _latestChainTip   = tip }
export function setScannedBlock(b)  { _lastScannedBlock = b   }
export function getChainTip()       { return _latestChainTip   }
export function getScannedBlock()   { return _lastScannedBlock }

// Caught up = within 200 blocks of chain tip
export function isCaughtUp() {
  return _latestChainTip > 0 && _lastScannedBlock >= _latestChainTip - 200
}
