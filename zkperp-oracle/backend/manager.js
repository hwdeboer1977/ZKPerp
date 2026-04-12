/**
 * ZKPerp Oracle Manager — no coordinator version
 *
 * Spawns 3 independent relayer processes (A, B, C).
 * Each has its own Aleo private key and submits directly on-chain.
 * No coordinator process — quorum is handled by zkperp_oracle.aleo.
 *
 * Relayers are staggered 60s apart on startup AND each relayer waits
 * for tx confirmation before moving to the next market. This eliminates
 * same-block finalize race conditions entirely.
 *
 * Timeline per cycle (120s poll interval):
 *   T+0s:   A starts, submits BTC → waits confirm (~30s)
 *   T+30s:  A submits ETH → waits confirm (~30s)
 *   T+60s:  A submits SOL → waits confirm, B starts submitting BTC
 *   T+90s:  B submits ETH, A done for this cycle
 *   T+120s: B submits SOL, C starts submitting BTC
 *   ...quorum reached per asset after A+B confirm
 *
 * Usage: node manager.js
 *        npm start
 */

import dotenv from 'dotenv';
dotenv.config();

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESTART_DELAY_MS = 5000;

const RELAYERS = ['A', 'B', 'C'];

function spawnRelayer(name, index) {
  function start() {
    console.log(`[Manager] Starting Relayer-${name}...`);

    const child = spawn('node', ['relayer.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        RELAYER_NAME:     name,
        ALEO_PRIVATE_KEY: process.env[`ALEO_PRIVATE_KEY_${name}`],
      }
    });

    child.on('exit', (code, signal) => {
      console.warn(`[Manager] Relayer-${name} exited (code=${code} signal=${signal}) — restarting in ${RESTART_DELAY_MS}ms`);
      setTimeout(start, RESTART_DELAY_MS);
    });

    child.on('error', (err) => {
      console.error(`[Manager] Relayer-${name} error:`, err.message);
    });
  }

  // Stagger startup 60s apart — A=0s, B=60s, C=120s
  // Relayer also has internal stagger offset so pattern holds after restarts
  setTimeout(start, index * 60_000);
}

console.log('[Manager] ZKPerp Oracle starting (sequential confirmation mode)...');
console.log('[Manager] Startup stagger: A=0s B=60s C=120s');
console.log('[Manager] Each relayer waits for tx confirmation before next market');

RELAYERS.forEach((name, i) => spawnRelayer(name, i));

process.on('SIGINT',  () => { console.log('\n[Manager] Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[Manager] Shutting down');   process.exit(0); });
