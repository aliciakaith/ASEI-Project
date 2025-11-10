// src/utils/errorNotification.js
import { query } from "../db/postgres.js";
import { sendMail } from "../mailer.js";

/**
 * Send error alert email to user if they have error alerts enabled
 * @param {string} userId - User ID to check preferences
 * @param {Object} errorDetails - Details about the error
 * @param {string} errorDetails.type - Type of error (e.g., 'FLOW_EXECUTION', 'API_ERROR')
 * @param {string} errorDetails.message - Error message
 * @param {string} errorDetails.flowName - Name of the flow (if applicable)
 * @param {string} errorDetails.executionId - Execution ID (if applicable)
 * @param {Object} errorDetails.metadata - Additional metadata
 */
export async function sendErrorAlert(userId, errorDetails) {
  try {
    // Check if user has error alerts enabled
    const result = await query(
      "SELECT email, first_name, last_name, send_error_alerts FROM users WHERE id=$1",
      [userId]
    );

    if (result.rowCount === 0) {
      console.warn(`User ${userId} not found for error notification`);
      return;
    }

    const user = result.rows[0];

    // Don't send if user has disabled error alerts
    if (user.send_error_alerts === false) {
      console.log(`User ${userId} has error alerts disabled, skipping notification`);
      return;
    }

    const userName = user.first_name ? `${user.first_name} ${user.last_name || ''}`.trim() : user.email;

    // Generate email content
    const { subject, text, html } = generateErrorEmail(userName, errorDetails);

    // Send the email
    await sendMail({
      to: user.email,
      subject,
      text,
      html
    });

    console.log(`✅ Error alert sent to ${user.email} for ${errorDetails.type}`);
  } catch (error) {
    // Don't throw - we don't want notification failures to break the main flow
    console.error('Failed to send error notification:', error);
  }
}

/**
 * Generate error email content
 */
function generateErrorEmail(userName, errorDetails) {
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'UTC',
    dateStyle: 'full',
    timeStyle: 'long'
  });

  const subject = `🚨 Error Alert: ${errorDetails.type || 'System Error'}`;

  const text = `
Hi ${userName},

An error has occurred in your Connectify integration:

Error Type: ${errorDetails.type || 'Unknown'}
${errorDetails.flowName ? `Flow: ${errorDetails.flowName}` : ''}
${errorDetails.executionId ? `Execution ID: ${errorDetails.executionId}` : ''}
Time: ${timestamp}

Error Message:
${errorDetails.message || 'No error message provided'}

${errorDetails.metadata ? `Additional Details:\n${JSON.stringify(errorDetails.metadata, null, 2)}` : ''}

You can view more details in your Connectify dashboard:
${process.env.FRONTEND_ORIGIN || 'http://localhost:3000'}/monitoring.html

To disable these alerts, go to Settings > Notifications and uncheck "Send error alerts".

---
Connectify Notification System
  `.trim();

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;padding:20px;background:#0f172a;color:#ffffff;max-width:600px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <div style="font-size:32px">🚨</div>
        <h2 style="margin:0;color:#ffffff">Error Alert</h2>
      </div>
      
      <p style="margin:0 0 16px;color:#e2e8f0">Hi ${userName},</p>
      
      <p style="margin:0 0 16px;color:#e2e8f0">An error has occurred in your Connectify integration:</p>
      
      <div style="background:#1e293b;border-left:4px solid #ef4444;padding:16px;margin:16px 0;border-radius:4px">
        <div style="margin-bottom:12px">
          <strong style="color:#fbbf24">Error Type:</strong>
          <div style="color:#e2e8f0;margin-top:4px">${errorDetails.type || 'Unknown'}</div>
        </div>
        
        ${errorDetails.flowName ? `
          <div style="margin-bottom:12px">
            <strong style="color:#fbbf24">Flow:</strong>
            <div style="color:#e2e8f0;margin-top:4px">${errorDetails.flowName}</div>
          </div>
        ` : ''}
        
        ${errorDetails.executionId ? `
          <div style="margin-bottom:12px">
            <strong style="color:#fbbf24">Execution ID:</strong>
            <div style="color:#e2e8f0;margin-top:4px;font-family:monospace;font-size:12px">${errorDetails.executionId}</div>
          </div>
        ` : ''}
        
        <div style="margin-bottom:12px">
          <strong style="color:#fbbf24">Time:</strong>
          <div style="color:#e2e8f0;margin-top:4px">${timestamp}</div>
        </div>
        
        <div>
          <strong style="color:#fbbf24">Error Message:</strong>
          <div style="color:#ef4444;margin-top:4px;font-family:monospace;font-size:13px;background:#0f172a;padding:12px;border-radius:4px;white-space:pre-wrap">${errorDetails.message || 'No error message provided'}</div>
        </div>
        
        ${errorDetails.metadata ? `
          <div style="margin-top:12px">
            <strong style="color:#fbbf24">Additional Details:</strong>
            <pre style="color:#94a3b8;margin-top:4px;font-size:11px;background:#0f172a;padding:12px;border-radius:4px;overflow-x:auto">${JSON.stringify(errorDetails.metadata, null, 2)}</pre>
          </div>
        ` : ''}
      </div>
      
      <div style="margin:20px 0">
        <a href="${process.env.FRONTEND_ORIGIN || 'http://localhost:3000'}/monitoring.html" 
           style="display:inline-block;background:#3b82f6;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:600">
          View in Dashboard
        </a>
      </div>
      
      <p style="margin:20px 0 0;font-size:12px;color:#64748b;border-top:1px solid #334155;padding-top:16px">
        To disable these alerts, go to <strong>Settings > Notifications</strong> and uncheck "Send error alerts".
      </p>
    </div>
  `;

  return { subject, text, html };
}
