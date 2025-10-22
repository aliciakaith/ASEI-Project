import CryptoJS from "crypto-js";
const ENC_KEY = process.env.SECRETS_ENC_KEY || "dev-only-change-me-please";

export function encryptJSON(obj) {
  return CryptoJS.AES.encrypt(JSON.stringify(obj), ENC_KEY).toString();
}
export function decryptJSON(cipher) {
  const bytes = CryptoJS.AES.decrypt(cipher, ENC_KEY);
  return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
}