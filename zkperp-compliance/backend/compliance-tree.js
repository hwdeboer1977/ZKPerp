import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initThreadPool, BHP256, Address, Field } from '@provablehq/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, 'tree-cache.json');
const DEPTH = 10;
const TREE_SIZE = 2 ** DEPTH;

// SDK init
let _sdkReady = false;
async function ensureSDK() {
  if (_sdkReady) return;
  await initThreadPool();
  _sdkReady = true;
}

// BHP256 hashing — matches test_hashes_v1.aleo exactly:
//   get_leaf(addr)        = BHP256::hash_to_field(addr)
//   get_node(left, right) = BHP256::hash_to_field(FieldPair { left, right })

export async function hashLeaf(address) {
  await ensureSDK();
  return BHP256.hashToField(address, 'address', 'field');
}

export async function hashNode(left, right) {
  await ensureSDK();
  // FieldPair { left, right } encodes as two consecutive fields
  const encoded = left + right;
  return BHP256.hashToField(encoded, 'struct', 'field');
}

// Pre-computed zero hashes (BHP256 chained) — unchanged from original
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

// Cache
function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return null; }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

export class MerkleTree {
  constructor(addresses, layers, leafHashes) {
    this.addresses  = [...addresses];
    this.zeroHashes = ZERO_HASHES;
    this.layers     = layers;
    this.leafHashes = leafHashes;
  }

  static fromCache(addresses) {
    const cache = loadCache();
    if (cache && JSON.stringify(cache.addresses) === JSON.stringify(addresses)) {
      console.log('[tree] Loaded from cache ✓');
      return new MerkleTree(cache.addresses, cache.layers, cache.leafHashes);
    }
    return null;
  }

  // Note: build() is now async because hashLeaf/hashNode are async
  static async build(addresses, existingLeafHashes = {}) {
    console.log(`[tree] Building tree for ${addresses.length} addresses...`);
    await ensureSDK();
    const leafHashes = { ...existingLeafHashes };

    const leaves = [];
    for (let i = 0; i < TREE_SIZE; i++) {
      if (i < addresses.length) {
        const addr = addresses[i];
        if (!leafHashes[addr]) {
          console.log(`  computing leaf for ${addr.slice(0, 16)}...`);
          leafHashes[addr] = await hashLeaf(addr);
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
        if (current[i] === ZERO_HASHES[level] && current[i + 1] === ZERO_HASHES[level]) {
          next.push(ZERO_HASHES[level + 1]);
        } else {
          next.push(await hashNode(current[i], current[i + 1]));
        }
      }
      layers.push(next);
      current = next;
      console.log(`  level ${level + 1}/${DEPTH} done`);
    }

    const tree = new MerkleTree(addresses, layers, leafHashes);
    saveCache({ addresses, layers, leafHashes });
    console.log(`[tree] Root: ${tree.root} (cached)`);
    return tree;
  }

  get root() { return this.layers[DEPTH][0]; }

  getProof(address) {
    const leafIndex = this.addresses.indexOf(address);
    if (leafIndex === -1) throw new Error(`Address ${address} not in allowlist`);
    const pathArr = [];
    let index = leafIndex;
    for (let level = 0; level < DEPTH; level++) {
      const isLeft       = index % 2 === 1;
      const siblingIndex = isLeft ? index - 1 : index + 1;
      const sibling      = this.layers[level][siblingIndex] ?? this.zeroHashes[level];
      pathArr.push({ sibling, is_left: isLeft });
      index = Math.floor(index / 2);
    }
    return { path: pathArr };
  }

  formatProofForLeo(address) {
    const { path } = this.getProof(address);
    return `{path: [${path.map(n => `{sibling: ${n.sibling}, is_left: ${n.is_left}}`).join(', ')}]}`;
  }

  formatProofForAPI(address) {
    return this.getProof(address).path.map(n => ({ sibling: n.sibling, is_left: n.is_left }));
  }
}
