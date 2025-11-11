// src/mailer.js
import nodemailer from "nodemailer";

const port = Number(process.env.SMTP_PORT || 587);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: port,
  secure: port === 465, // true for 465 (SSL), false for 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000, // 10 second timeout
  greetingTimeout: 10000,
});

// --- Verify SMTP connection at startup (helpful for debugging) ---
transporter.verify()
  .then(() => {
    console.log("✅ SMTP transporter ready — mail will be sent using", process.env.SMTP_HOST);
  })
  .catch((err) => {
    console.error("❌ SMTP transporter verify failed:", err && err.message ? err.message : err);
  });

export async function sendMail({ to, subject, text, html, attachments } = {}) {
  const mailOptions = {
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  };
  if (attachments) mailOptions.attachments = attachments;
  return transporter.sendMail(mailOptions);
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

