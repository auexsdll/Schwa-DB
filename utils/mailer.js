const nodemailer = require('nodemailer');

const DEFAULT_FROM = 'Schwa Scanner <noreply@schwadevelopment.com.tr>';
const BRAND_URL = process.env.PUBLIC_WEB_URL || 'https://www.schwadevelopment.com.tr';

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getMailFrom() {
  return process.env.MAIL_FROM || process.env.RESEND_FROM || DEFAULT_FROM;
}

function getResendKey() {
  return process.env.RESEND_API_KEY || process.env.RESEND_KEY || (!process.env.SMTP_HOST ? process.env.SMTP_PASS : '');
}

function buildShell({ title, preheader, accent = '#38bdf8', content, footer = 'Schwa Development' }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; padding: 0; background: #050506; color: #ffffff; font-family: Arial, Helvetica, sans-serif; }
    .preheader { display: none; visibility: hidden; opacity: 0; color: transparent; height: 0; width: 0; overflow: hidden; }
    .wrapper { width: 100%; background: #050506; padding: 34px 0; }
    .container { max-width: 620px; margin: 0 auto; background: #0b0c10; border: 1px solid #1f2937; border-radius: 18px; overflow: hidden; }
    .header { padding: 34px 28px; text-align: center; background: radial-gradient(circle at top, ${accent}22 0%, #0b0c10 64%); border-bottom: 1px solid #171923; }
    .logo { max-width: 132px; margin-bottom: 16px; }
    h1 { margin: 0; color: ${accent}; font-size: 25px; line-height: 1.2; }
    .content { padding: 34px 34px 26px; color: #cbd5e1; font-size: 15px; line-height: 1.65; }
    .content strong, .highlight { color: #ffffff; }
    .panel { background: #050506; border: 1px solid #243244; border-radius: 14px; padding: 18px; margin: 22px 0; }
    .key { color: #ffffff; font-family: Consolas, Monaco, monospace; font-size: 24px; font-weight: 800; letter-spacing: 2px; }
    .muted { color: #64748b; font-size: 12px; }
    .footer { padding: 22px 28px; text-align: center; border-top: 1px solid #171923; color: #64748b; font-size: 12px; background: #050506; }
    a { color: ${accent}; }
  </style>
</head>
<body>
  <span class="preheader">${escapeHtml(preheader || title)}</span>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <img src="${BRAND_URL}/logo.png" alt="Schwa" class="logo">
        <h1>${escapeHtml(title)}</h1>
      </div>
      <div class="content">${content}</div>
      <div class="footer">${escapeHtml(footer)}<br>© 2026 Schwa Development. All rights reserved.</div>
    </div>
  </div>
</body>
</html>`;
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = getResendKey();
  if (!apiKey) {
    return { sent: false, skipped: true, provider: 'resend', reason: 'missing_api_key' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: getMailFrom(),
      to,
      subject,
      html
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Resend failed (${response.status}): ${data.message || data.error || response.statusText}`);
  }

  return { sent: true, provider: 'resend', id: data.id || null };
}

async function sendViaSmtp({ to, subject, html }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { sent: false, skipped: true, provider: 'smtp', reason: 'missing_smtp_config' };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const info = await transporter.sendMail({
    from: getMailFrom(),
    to,
    subject,
    html
  });

  return { sent: true, provider: 'smtp', id: info.messageId || null };
}

async function sendEmail(payload) {
  if (!payload.to) {
    return { sent: false, skipped: true, reason: 'missing_recipient' };
  }

  try {
    const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const result = hasSmtp ? await sendViaSmtp(payload) : await sendViaResend(payload);
    if (result.skipped) {
      console.warn('Email skipped:', payload.subject, result.reason);
    }
    return result;
  } catch (error) {
    console.error('Email send error:', error.message);
    return { sent: false, skipped: false, error: error.message };
  }
}

function applicationReceivedEmail(application) {
  const username = escapeHtml(application.username);
  const discord = escapeHtml(application.discord || 'N/A');
  return buildShell({
    title: 'Application Received',
    preheader: `We received ${application.username}'s access request.`,
    accent: '#22d3ee',
    content: `
      <p>Hello <span class="highlight">${username}</span>,</p>
      <p>Your Schwa Scanner access application has been received and added to the admin review queue.</p>
      <div class="panel">
        <p><strong>Discord:</strong> ${discord}</p>
        <p><strong>Status:</strong> Pending review</p>
      </div>
      <p class="muted">You will receive another email after a God Panel reviewer approves or rejects the request.</p>
    `,
    footer: 'Application queue notification'
  });
}

function applicationDecisionEmail(application, decision, generatedKey) {
  const approved = decision === 'approved';
  const username = escapeHtml(application.username);
  return buildShell({
    title: approved ? 'Access Granted' : 'Application Denied',
    preheader: approved ? 'Your Schwa Scanner license has been generated.' : 'Your application was reviewed.',
    accent: approved ? '#22c55e' : '#ef4444',
    content: approved ? `
      <p>Hello <span class="highlight">${username}</span>,</p>
      <p>Your application for <strong>Schwa Scanner</strong> has been approved.</p>
      <div class="panel">
        <div class="muted">Your Unique License Key</div>
        <div class="key">${escapeHtml(generatedKey || '')}</div>
      </div>
      <p class="muted">Keep this key private. You will use it to authenticate your scanner.</p>
    ` : `
      <p>Hello <span class="highlight">${username}</span>,</p>
      <p>After review, your application for <strong>Schwa Scanner</strong> was not approved at this time.</p>
      <p class="muted">This message was sent automatically after the God Panel decision.</p>
    `,
    footer: 'Access review notification'
  });
}

function referralWelcomeEmail({ username, teamName, password, key }) {
  return buildShell({
    title: 'Welcome to Schwa Scanner',
    preheader: `You joined ${teamName}.`,
    accent: '#6366f1',
    content: `
      <p>Hello <span class="highlight">${escapeHtml(username)}</span>,</p>
      <p>Your team access has been created successfully.</p>
      <div class="panel">
        <p><strong>Team:</strong> ${escapeHtml(teamName)}</p>
        <p><strong>Username:</strong> ${escapeHtml(username)}</p>
        <p><strong>Password:</strong> ${escapeHtml(password)}</p>
        <p><strong>License Key:</strong> <span class="key" style="font-size:18px">${escapeHtml(key)}</span></p>
      </div>
      <p class="muted">You can log in with either your password or license key.</p>
    `,
    footer: 'Team registration notification'
  });
}

function accountStatusEmail(application, action) {
  const config = {
    frozen: {
      title: 'Account Frozen',
      subject: 'Your Schwa Scanner account has been frozen',
      accent: '#f59e0b',
      body: 'Your account has been temporarily frozen by the administrative team. You will not be able to log in or use your license key while it is frozen.'
    },
    reactivated: {
      title: 'Account Reactivated',
      subject: 'Your Schwa Scanner account has been reactivated',
      accent: '#22c55e',
      body: 'Your account has been reactivated by the administrative team. You can now log in and continue using your license key.'
    },
    closed: {
      title: 'Account Closed',
      subject: 'Your Schwa Scanner account has been closed',
      accent: '#ef4444',
      body: 'Your account has been permanently closed and deleted by the administrative team.'
    }
  }[action];

  if (!config) return null;
  return {
    subject: config.subject,
    html: buildShell({
      title: config.title,
      preheader: config.body,
      accent: config.accent,
      content: `
        <p>Hello <span class="highlight">${escapeHtml(application.username)}</span>,</p>
        <p>${escapeHtml(config.body)}</p>
      `,
      footer: 'Account status notification'
    })
  };
}

function passwordResetEmail(userRecord, newPassword) {
  return buildShell({
    title: 'Password Reset',
    preheader: 'Your Schwa Scanner password was reset.',
    accent: '#38bdf8',
    content: `
      <p>Hello <span class="highlight">${escapeHtml(userRecord.label)}</span>,</p>
      <p>Your password has been reset successfully.</p>
      <div class="panel">
        <p><strong>Username:</strong> ${escapeHtml(userRecord.label)}</p>
        <p><strong>New Password:</strong> ${escapeHtml(newPassword)}</p>
      </div>
      <p class="muted">If you did not request this, contact an administrator immediately.</p>
    `,
    footer: 'Password reset notification'
  });
}

module.exports = {
  escapeHtml,
  sendEmail,
  applicationReceivedEmail,
  applicationDecisionEmail,
  referralWelcomeEmail,
  accountStatusEmail,
  passwordResetEmail
};
