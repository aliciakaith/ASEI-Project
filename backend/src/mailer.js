// src/mailer.js
import nodemailer from "nodemailer";

// Use SendGrid if SENDGRID_API_KEY is set, otherwise fall back to SMTP
const useSendGrid = !!process.env.SENDGRID_API_KEY;

let transporter;

if (useSendGrid) {
  console.log("📧 Using SendGrid for email delivery");
  transporter = nodemailer.createTransport({
    host: "smtp.sendgrid.net",
    port: 587,
    secure: false,
    auth: {
      user: "apikey",
      pass: process.env.SENDGRID_API_KEY,
    },
  });
} else {
  console.log("📧 Using SMTP for email delivery");
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
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
}

// --- Verify email connection at startup (helpful for debugging) ---
// Set a timeout to prevent blocking if email service is slow/unavailable
const verifyTimeout = setTimeout(() => {
  console.warn("⚠️  Email verification timed out - emails may still work");
}, 5000);

transporter.verify()
  .then(() => {
    clearTimeout(verifyTimeout);
    console.log("✅ Email transporter ready");
  })
  .catch((err) => {
    clearTimeout(verifyTimeout);
    console.warn("⚠️  Email transporter verify failed:", err && err.message ? err.message : err);
    console.warn("⚠️  Will attempt to send emails anyway. Check email settings if emails don't arrive.");
  });

export async function sendMail({ to, subject, text, html, attachments } = {}) {
  const mailOptions = {
    from: process.env.MAIL_FROM || process.env.SMTP_USER || "noreply@asei.app",
    to,
    subject,
    text,
    html,
  };
  if (attachments) mailOptions.attachments = attachments;
  
  console.log(`📧 Attempting to send email to ${to} with subject: ${subject}`);
  console.log(`📧 Using SendGrid: ${useSendGrid ? 'YES' : 'NO'}`);
  console.log(`📧 From address: ${mailOptions.from}`);
  
  try {
    const result = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent successfully to ${to}:`, result.messageId);
    return result;
  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);
    console.error('Full error:', error);
    throw error;
  }
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

