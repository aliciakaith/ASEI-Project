import axios from "axios";

export async function getAccessToken({ subscriptionKey, apiUserId, apiKey, baseUrl }) {
  const basic = Buffer.from(`${apiUserId}:${apiKey}`).toString("base64");
  const { data } = await axios.post(
    `${baseUrl}/collection/token/`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${basic}`,
        "Ocp-Apim-Subscription-Key": subscriptionKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    }
  );
  return data; // { access_token, expires_in, token_type }
}