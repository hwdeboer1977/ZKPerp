import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { spawnSync } = require('child_process');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEO_HASHER_DIR = process.env.LEO_HASHER_DIR || '/tmp/test_hashes';
const LEO_BIN = process.env.LEO_BIN || '/home/lupo1977/.cargo/bin/leo';
const CACHE_PATH = path.join(__dirname, 'tree-cache.json');
const DEPTH = 10;
const TREE_SIZE = 2 ** DEPTH;

// ─── Hardcoded zero hashes ────────────────────────────────────────────────────
export const ZERO_HASHES = [
  '0field',
  '5975188031198556945789735160261123857786460669093998299590878014857269115118field',
  '3256447892203426872607084413367309006309198604149042015341470865091243985627field',
  '314282459558416524113510779128335872579904299568097253697072446322327266261field',
  '8109128966588956814430976739095305370608889057015672229236686903145956139804field',
  '2941446317496376430785784266498055592787995859996489163153876077164811984396field',
  '6579392867006596156909172051157147654525832073664500038677836783673555971831field',
  '1639376983891342618565577366952941373520897109066178464651426710843894795011field',
  '715775178175289950847432497119592594104218258251417720843046614547038033032field',
  '3603318153436045703782238419066277527552674807761328993794897658083776519659field',
  '2453189239101005812802743895228514508924424802739289099477965789488702684817field',
];

// ─── Leo subprocess ───────────────────────────────────────────────────────────

function leoRun(fnName, ...args) {
  const result = spawnSync(LEO_BIN, ['run', fnName, ...args], {
    cwd: LEO_HASHER_DIR,
    encoding: 'utf8',
    env: { ...process.env, PATH: `/home/lupo1977/.cargo/bin:/usr/bin:/bin` },
  });
  if (result.error) throw result.error;
  const output = (result.stdout || '') + (result.stderr || '');
  const match = output.match(/•\s*([^\n]+field)/);
  if (!match) throw new Error(`leo run ${fnName} failed: ${output.slice(0, 200)}`);
  return match[1].trim();
}

export function hashLeaf(address) { return leoRun('get_leaf', address); }
export function hashNode(left, right) { return leoRun('get_node', left, right); }

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch { return null; }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

// ─── MerkleTree ───────────────────────────────────────────────────────────────

export class MerkleTree {
  constructor(addresses, layers, leafHashes) {
    this.addresses  = [...addresses];
    this.zeroHashes = ZERO_HASHES;
    this.layers     = layers;
    this.leafHashes = leafHashes; // { address: fieldHash }
  }

  // Load from disk cache — instant, no leo run
  static fromCache(addresses) {
    const cache = loadCache();
    if (
      cache &&
      JSON.stringify(cache.addresses) === JSON.stringify(addresses)
    ) {
      console.log('[tree] Loaded from cache ✓');
      return new MerkleTree(cache.addresses, cache.layers, cache.leafHashes);
    }
    return null;
  }

  // Build from scratch — calls leo run for new leaves/nodes
  static build(addresses, existingLeafHashes = {}) {
    console.log(`[tree] Building tree for ${addresses.length} addresses...`);
    const leafHashes = { ...existingLeafHashes };

    // Hash any new leaves
    const leaves = [];
    for (let i = 0; i < TREE_SIZE; i++) {
      if (i < addresses.length) {
        const addr = addresses[i];
        if (!leafHashes[addr]) {
          console.log(`  computing leaf for ${addr.slice(0, 16)}...`);
          leafHashes[addr] = hashLeaf(addr);
        }
        leaves.push(leafHashes[addr]);
      } else {
        leaves.push(ZERO_HASHES[0]);
      }
    }

    const layers = [leaves];
    let current = leaves;

    for (let level = 0; level < DEPTH; level++) {
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        if (
          current[i] === ZERO_HASHES[level] &&
          current[i + 1] === ZERO_HASHES[level]
        ) {
          next.push(ZERO_HASHES[level + 1]);
        } else {
          next.push(hashNode(current[i], current[i + 1]));
        }
      }
      layers.push(next);
      current = next;
      console.log(`  level ${level + 1}/${DEPTH} done`);
    }

    const tree = new MerkleTree(addresses, layers, leafHashes);

    // Persist cache
    saveCache({ addresses, layers, leafHashes });
    console.log(`[tree] Root: ${tree.root} (cached)`);

    return tree;
  }

  get root() { return this.layers[DEPTH][0]; }

  getProof(address) {
    const leafIndex = this.addresses.indexOf(address);
    if (leafIndex === -1) throw new Error(`Address ${address} not in allowlist`);
    const path = [];
    let index = leafIndex;
    for (let level = 0; level < DEPTH; level++) {
      const isLeft       = index % 2 === 1;
      const siblingIndex = isLeft ? index - 1 : index + 1;
      const sibling      = this.layers[level][siblingIndex] ?? this.zeroHashes[level];
      path.push({ sibling, is_left: isLeft });
      index = Math.floor(index / 2);
    }
    return { path };
  }

  formatProofForLeo(address) {
    const { path } = this.getProof(address);
    return `{path: [${path.map(n => `{sibling: ${n.sibling}, is_left: ${n.is_left}}`).join(', ')}]}`;
  }

  formatProofForAPI(address) {
    return this.getProof(address).path.map(n => ({ sibling: n.sibling, is_left: n.is_left }));
  }
}
