// ZKPerp contract constants
export const PROGRAM_ID = 'zkperp_v1.aleo';
export const SCALE = 1_000_000; // 6 decimals for amounts
export const PRICE_SCALE = 100_000_000; // 8 decimals for prices

// Format USDC amount (6 decimals) to display string
export function formatUsdc(amount: number | bigint): string {
  const value = Number(amount) / SCALE;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Format price (8 decimals) to display string
export function formatPrice(price: number | bigint): string {
  const value = Number(price) / PRICE_SCALE;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Parse USDC input to u64 (6 decimals)
export function parseUsdc(input: string): bigint {
  const value = parseFloat(input);
  if (isNaN(value) || value < 0) return BigInt(0);
  return BigInt(Math.floor(value * SCALE));
}

// Parse price input to u64 (8 decimals)
export function parsePrice(input: string): bigint {
  const value = parseFloat(input);
  if (isNaN(value) || value < 0) return BigInt(0);
  return BigInt(Math.floor(value * PRICE_SCALE));
}

// Calculate leverage from collateral and size
export function calculateLeverage(collateral: bigint, size: bigint): number {
  if (collateral === BigInt(0)) return 0;
  return Number(size) / Number(collateral);
}

// Calculate liquidation price for a position
export function calculateLiquidationPrice(
  entryPrice: bigint,
  isLong: boolean,
  leverage: number
): bigint {
  const entry = Number(entryPrice);
  const margin = 0.99 / leverage;
  
  if (isLong) {
    return BigInt(Math.floor(entry * (1 - margin)));
  } else {
    return BigInt(Math.floor(entry * (1 + margin)));
  }
}

// Generate a random nonce for position creation
export function generateNonce(): string {
  const randomBytes = new Uint8Array(31);
  crypto.getRandomValues(randomBytes);
  let nonce = BigInt(0);
  for (const byte of randomBytes) {
    nonce = (nonce << BigInt(8)) | BigInt(byte);
  }
  return nonce.toString() + 'field';
}

// Truncate address for display
export function truncateAddress(address: string): string {
  if (!address || address.length < 20) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

// Calculate PnL
export function calculatePnL(
  entryPrice: bigint,
  currentPrice: bigint,
  size: bigint,
  isLong: boolean
): { pnl: number; pnlPercent: number; isProfit: boolean } {
  const entry = Number(entryPrice);
  const current = Number(currentPrice);
  const posSize = Number(size) / SCALE;
  
  const priceDiff = current - entry;
  const pnlRaw = (priceDiff / entry) * posSize;
  
  const pnl = isLong ? pnlRaw : -pnlRaw;
  const pnlPercent = (priceDiff / entry) * 100 * (isLong ? 1 : -1);
  
  return {
    pnl,
    pnlPercent,
    isProfit: pnl >= 0,
  };
}
