/**
 * ZKPerp Oracle Manager — no coordinator version
 *
 * Spawns 3 independent relayer processes (A, B, C).
 * Each has its own Aleo private key and submits directly on-chain.
 * No coordinator process — quorum is handled by zkperp_oracle.aleo.
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
const RESTART_DELAY_MS = 3000;

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

  // Stagger startup 1s apart
  setTimeout(start, index * 1000);
}

console.log('[Manager] ZKPerp Oracle starting (no-coordinator mode)...');
console.log('[Manager] Each relayer submits independently to zkperp_oracle.aleo');

RELAYERS.forEach((name, i) => spawnRelayer(name, i));

process.on('SIGINT',  () => { console.log('\n[Manager] Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[Manager] Shutting down');   process.exit(0); });
