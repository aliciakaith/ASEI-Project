// src/mailer.js
import nodemailer from "nodemailer";

// Use SendGrid HTTP API if SENDGRID_API_KEY is set, otherwise fall back to SMTP
const useSendGrid = !!process.env.SENDGRID_API_KEY;

let transporter;
let sendGridFetch; // For HTTP API

if (useSendGrid) {
  console.log("📧 Using SendGrid HTTP API for email delivery (no SMTP ports needed)");
  // We'll use fetch to call SendGrid's HTTP API directly
  sendGridFetch = true;
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

  // --- Verify email connection at startup (helpful for debugging) ---
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
}

export async function sendMail({ to, subject, text, html, attachments } = {}) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || "noreply@asei.app";
  
  console.log(`📧 Attempting to send email to ${to} with subject: ${subject}`);
  console.log(`📧 Using SendGrid HTTP API: ${sendGridFetch ? 'YES' : 'NO'}`);
  console.log(`📧 From address: ${from}`);
  
  try {
    if (sendGridFetch) {
      // Use SendGrid HTTP API v3
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{
            to: [{ email: to }],
            subject: subject,
          }],
          from: { email: from },
          content: [
            { type: 'text/plain', value: text || '' },
            { type: 'text/html', value: html || text || '' },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`SendGrid API error: ${response.status} ${errorText}`);
      }

      console.log(`✅ Email sent successfully to ${to} via SendGrid HTTP API`);
      return { messageId: response.headers.get('x-message-id') };
    } else {
      // Use SMTP
      const mailOptions = {
        from,
        to,
        subject,
        text,
        html,
      };
      if (attachments) mailOptions.attachments = attachments;
      
      const result = await transporter.sendMail(mailOptions);
      console.log(`✅ Email sent successfully to ${to}:`, result.messageId);
      return result;
    }
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

