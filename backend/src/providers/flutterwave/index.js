import fetch from 'node-fetch';

export default function flutterwaveClient({ secretKey, baseUrl = 'https://api.flutterwave.com/v3' }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${secretKey}`,
  };

  return {
    async ping() {
      const r = await fetch(`${baseUrl}/banks/NG`, { headers });
      if (!r.ok) throw new Error(`Verify failed: ${r.status} ${await r.text()}`);
      return true;
    },

    async createPayment({ amount, currency, tx_ref, customer, meta, redirect_url }) {
      const body = { tx_ref, amount, currency, customer, meta, redirect_url };
      const r = await fetch(`${baseUrl}/payments`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.message || 'Payment create failed');
      return json; // hosted checkout link in json.data.link
    },

    async verifyByReference(tx_ref) {
      const r = await fetch(`${baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(tx_ref)}`, { headers });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.message || 'Verify failed');
      return json;
    },
  };
}
