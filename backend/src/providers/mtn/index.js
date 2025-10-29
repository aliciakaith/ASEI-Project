// src/providers/mtn/index.js
import axios from "axios";
import { getAccessToken } from "./auth.js";

export class MTNConnector {
  constructor(cfg) {
    this.cfg = cfg;
    this.baseUrl = cfg.baseUrl || "https://sandbox.momodeveloper.mtn.com";
  }

  async _headers() {
    const token = await getAccessToken({
      subscriptionKey: this.cfg.subscriptionKey,
      apiUserId: this.cfg.apiUserId,
      apiKey: this.cfg.apiKey,
      baseUrl: this.baseUrl,
    });
    return {
      Authorization: `Bearer ${token.access_token}`,
      "X-Target-Environment": this.cfg.targetEnvironment || "sandbox",
      "Ocp-Apim-Subscription-Key": this.cfg.subscriptionKey,
      "Content-Type": "application/json",
    };
  }

async requestToPay({ amount, currency, msisdn, externalId, referenceId, message, callbackUrl }) {
  const url = `${this.baseUrl}/collection/v1_0/requesttopay`;
  const headers = await this._headers();
  const body = {
    amount,
    currency,
    externalId,
    payer: { partyIdType: "MSISDN", partyId: msisdn },
    payerMessage: message || "Payment Request",
    payeeNote: "Connectify API"
    // ❌ do not include callbackUrl in the body
  };
  await axios.post(url, body, {
  headers: {
    ...headers,
    "X-Reference-Id": referenceId,
    "X-Callback-Url": callbackUrl,   // ✅ header (not in body)
  },
  timeout: 15000,
});
  // MTN usually returns 202 Accepted with no body
  return { referenceId, status: "PENDING" };
}


  async getStatus(referenceId) {
    const url = `${this.baseUrl}/collection/v1_0/requesttopay/${referenceId}`;
    const headers = await this._headers();
    const { data } = await axios.get(url, { headers });
    return data;
  }

  async getBalance() {
    const url = `${this.baseUrl}/collection/v1_0/account/balance`;
    const headers = await this._headers();
    const { data } = await axios.get(url, { headers });
    return data;
  }

  async getAccountHolder(msisdn) {
    const url = `${this.baseUrl}/collection/v1_0/accountholder/msisdn/${msisdn}/active`;
    const headers = await this._headers();
    const { data } = await axios.get(url, { headers });
    return data;
  }
}

