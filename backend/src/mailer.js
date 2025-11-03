// src/mailer.js
import nodemailer from "nodemailer";

const isSecure = String(process.env.SMTP_PORT || "") === "465";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || (isSecure ? 465 : 587)),
  secure: isSecure,                  // true for 465, false for 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  pool: true,                        // keep connections warm
  maxConnections: 2,
  maxMessages: 50,
  connectionTimeout: 10000,          // 10s to connect
  greetingTimeout: 10000,            // 10s to get greeting
  socketTimeout: 15000,              // 15s during SMTP dialogue
  // For dev: avoid cert issues. Remove or set to true in prod with real certs.
  tls: { rejectUnauthorized: false },
});

// --- Verify SMTP connection at startup (helpful for debugging) ---
transporter.verify()
  .then(() => {
    console.log("✅ SMTP ready —", process.env.SMTP_HOST, ":", process.env.SMTP_PORT);
  })
  .catch((err) => {
    console.error("❌ SMTP verify failed:", err?.message || err);
  });

export async function sendMail({ to, subject, text, html, attachments } = {}) {
  const mailOptions = {
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
    ...(attachments ? { attachments } : {}),
  };

  // Hard-cap total email time so HTTP routes don’t hang forever if SMTP stalls.
  const hardCapMs = 12000;
  const hardTimeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("smtp_timeout")), hardCapMs)
  );

  return Promise.race([transporter.sendMail(mailOptions), hardTimeout]);
}

export function verificationEmail(code) {
  const text = `Your Connectify verification code is ${code}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;padding:20px;background:#0f172a;color:#ffffff">
      <h2 style="margin:0 0 10px;color:#ffffff">Verify your Connectify account</h2>
      <p style="margin:0 0 16px;color:#ffffff">Use this code to finish setting up your account:</p>
      <div style="font-size:24px;font-weight:700;letter-spacing:4px;background:#111827;color:#ffffff;padding:12px 16px;border-radius:6px;display:inline-block">
        ${code}
      </div>
      <p style="margin-top:16px;font-size:12px;color:#ffffff">If you didn’t request this, ignore this email.</p>
    </div>`;
  return { text, html };
}
