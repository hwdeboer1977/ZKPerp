# ZKPerp Frontend

React + Vite frontend for the ZKPerp privacy-preserving perpetual DEX on Aleo.

## Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

## Prerequisites

1. **Leo Wallet** - Install the [Leo Wallet browser extension](https://leo.app)
2. **Local Devnet** - Aleo devnet running locally
3. **Deployed Contract** - `zkperp_v1.aleo` deployed to devnet

## Setup Devnet

```bash
# Terminal 1: Start devnet
cd ../leo
leo devnet --snarkos $(which snarkos) --snarkos-features test_network --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11 --clear-storage

# Terminal 2: Deploy contract
leo build
leo deploy --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11

# Set oracle price ($100,000 BTC)
leo execute update_price 0field 10000000000u64 1u32 --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11

# Add liquidity
leo execute add_liquidity 200000000u64 <YOUR_ADDRESS> --broadcast --consensus-heights 0,1,2,3,4,5,6,7,8,9,10,11
```

## Project Structure

```
src/
├── components/
│   ├── Header.tsx          # Wallet connection
│   ├── TradingWidget.tsx   # Open positions
│   ├── PositionDisplay.tsx # View/close positions
│   └── MarketInfo.tsx      # Pool stats
├── hooks/
│   └── useZKPerp.ts        # Contract interactions
├── utils/
│   └── aleo.ts             # Formatting helpers
├── App.tsx                 # Main app + wallet provider
├── main.tsx                # Entry point
└── index.css               # Tailwind styles
```

## Features

- 🔐 Leo Wallet integration
- 📈 Long/Short trading with up to 20x leverage
- 📊 Position management with PnL display
- 🎯 Simulated price for testing

## Scripts

```bash
npm run dev      # Start dev server
npm run build    # Production build
npm run preview  # Preview production build
npm run lint     # Run ESLint
```
