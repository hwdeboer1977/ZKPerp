/**
 * Provable API Client
 * Handles JWT auth and record scanning via Provable's infrastructure
 */

const PROVABLE_API_BASE = 'https://api.provable.com';

export class ProvableClient {
  constructor(consumerId, apiKey, network = 'testnet') {
    this.consumerId = consumerId;
    this.apiKey = apiKey;
    this.network = network;
    this.jwtToken = null;
    this.jwtExpiry = null;
    this.uuid = null;
  }

  async getJwtToken() {
    if (this.jwtToken && this.jwtExpiry && Date.now() < this.jwtExpiry) {
      return this.jwtToken;
    }

    const response = await fetch(`${PROVABLE_API_BASE}/jwts/${this.consumerId}`, {
      method: 'POST',
      headers: {
        'X-Provable-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get JWT: ${response.status} ${response.statusText}`);
    }

    const authHeader = response.headers.get('Authorization');
    if (authHeader) {
      this.jwtToken = authHeader.replace('Bearer ', '');
      this.jwtExpiry = Date.now() + 55 * 60 * 1000;
      return this.jwtToken;
    }

    const data = await response.json().catch(() => null);
    if (data?.token || data?.jwt) {
      this.jwtToken = data.token || data.jwt;
      this.jwtExpiry = Date.now() + 55 * 60 * 1000;
      return this.jwtToken;
    }

    throw new Error('JWT not found in response');
  }

  async registerViewKey(viewKey, startBlock = 0) {
    const token = await this.getJwtToken();
    const response = await fetch(`${PROVABLE_API_BASE}/scanner/${this.network}/register`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ view_key: viewKey, start: startBlock }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Registration failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    this.uuid = data.uuid;
    return data;
  }

  async getStatus() {
    if (!this.uuid) throw new Error('No UUID - call registerViewKey first');
    const token = await this.getJwtToken();

    const response = await fetch(`${PROVABLE_API_BASE}/scanner/${this.network}/status`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.uuid),
    });

    if (!response.ok) throw new Error(`Status check failed: ${response.status}`);
    return response.json();
  }

  async getOwnedRecords(options = {}) {
    if (!this.uuid) throw new Error('No UUID - call registerViewKey first');
    const token = await this.getJwtToken();

    const body = {
      uuid: this.uuid,
      decrypt: options.decrypt !== false,
      unspent: options.unspent !== false,
    };

    if (options.programs) {
      body.filter = { programs: options.programs };
    }

    body.response_filter = {
      block_height: true,
      commitment: true,
      record_ciphertext: true,
      function_name: true,
      nonce: true,
      owner: true,
      program_name: true,
      record_name: true,
      transaction_id: true,
      transition_id: true,
    };

    const response = await fetch(`${PROVABLE_API_BASE}/scanner/${this.network}/records/owned`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Get records failed: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  setUuid(uuid) {
    this.uuid = uuid;
  }
}
