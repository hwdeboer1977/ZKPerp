# ZKPerp Oracle + Liquidation Bot

Automated bot for ZKPerp v7 that updates oracle prices and liquidates underwater positions.

## Prerequisites

- **Node.js** 18+
- **snarkos** CLI installed and in PATH (`snarkos developer execute` must work)
- **ALEO credits** in the orchestrator wallet for transaction fees

## Setup

```bash
cd zkperp-bot
cp .env.example .env
# Edit .env with your private key
```

## Run

```bash
# Using environment variable
PRIVATE_KEY=APrivateKey1zkp... npm start

# Or with .env file (install dotenv first)
npm start
```

## What it does

### Oracle (every 30s)
- Fetches BTC/USD from CoinGecko (free, no API key)
- Skips update if price changed < 0.1% (saves fees)
- Calls `update_price` on zkperp_v7.aleo

### Liquidation Scanner (every 60s)
- Reads pool state (liquidity, open interest)
- Scans recent transactions for open positions
- Checks `closed_positions` mapping to filter closed ones
- Calculates margin ratio for each position
- Calls `liquidate` for positions below 1% margin
- Earns 0.5% of position size as reward

## Architecture

```
CoinGecko API ──→ Bot ──→ update_price (snarkos execute)
                   │
                   ├──→ Scan positions (Explorer API)
                   │
                   └──→ liquidate (snarkos execute)
```

The bot uses `snarkos developer execute` for on-chain transactions. This handles ZK proof generation natively without requiring the WASM SDK.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| PRIVATE_KEY | - | Orchestrator private key (required) |
| PROGRAM_ID | zkperp_v7.aleo | Contract program ID |
| API_ENDPOINT | Provable testnet | API for reading state |
| PRICE_INTERVAL | 30000 | Oracle update interval (ms) |
| SCAN_INTERVAL | 60000 | Liquidation scan interval (ms) |

## Costs

- Oracle update: ~0.5 ALEO per update (~1440/day at 30s intervals)
- Liquidation: ~5 ALEO per liquidation (earned back via 0.5% reward)
- Tip: Increase PRICE_INTERVAL to reduce oracle costs
