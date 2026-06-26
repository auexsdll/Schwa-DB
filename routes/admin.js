const express = require('express');
const router = express.Router();
const db = require('../database');
const axios = require('axios');

function logAudit(admin_username, action, target, details) {
  try {
    db.prepare('INSERT INTO audit_logs (admin_username, action, target, details) VALUES (?, ?, ?, ?)').run(
      admin_username || 'System', action, target || '', details || ''
    );
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

function normalizeBadges(rawBadges) {
  const source = Array.isArray(rawBadges) ? rawBadges : [];
  return source
    .map((badge, index) => {
      if (typeof badge === 'string') {
        return { id: `badge-${Date.now()}-${index}`, label: badge.trim(), color: '#38bdf8', icon: '' };
      }
      if (badge && typeof badge === 'object') {
        return {
          id: badge.id || `badge-${Date.now()}-${index}`,
          label: String(badge.label || '').trim(),
          color: String(badge.color || '#38bdf8').trim(),
          icon: String(badge.icon || '').trim()
        };
      }
      return null;
    })
    .filter(badge => badge && badge.label)
    .slice(0, 12);
}

async function sendCustomerEmail(username, action) {
  if (!process.env.SMTP_PASS) return;
  // Sadece müşteriler için application kaydı vardır, normal admin keyleri için dönmez.
  const application = db.prepare('SELECT * FROM applications WHERE username = ? COLLATE NOCASE').get(username);
  if (!application || !application.email) return;

  let subject = '';
  let contentHtml = '';
  let title = '';
  let headerColor = '';
  let titleColor = '';

  if (action === 'frozen') {
    subject = 'Your Schwa Scanner Account has been Frozen';
    title = 'Account Frozen';
    headerColor = '#450a0a';
    titleColor = '#f87171';
    contentHtml = `<p>Hello <span class="highlight">${application.username}</span>,<br><br>Your Schwa Scanner account has been temporarily <strong>frozen</strong> by the administrative team.<br><br>While your account is frozen, you will not be able to log in or use your license key.</p>`;
  } else if (action === 'reactivated') {
    subject = 'Your Schwa Scanner Account has been Reactivated';
    title = 'Account Reactivated';
    headerColor = '#052e16';
    titleColor = '#4ade80';
    contentHtml = `<p>Hello <span class="highlight">${application.username}</span>,<br><br>Your Schwa Scanner account has been <strong>reactivated</strong> by the administrative team.<br><br>You can now log in and continue using your license key.</p>`;
  } else if (action === 'closed') {
    subject = 'Your Schwa Scanner Account has been Closed';
    title = 'Account Closed';
    headerColor = '#450a0a';
    titleColor = '#f87171';
    contentHtml = `<p>Hello <span class="highlight">${application.username}</span>,<br><br>Your Schwa Scanner account has been permanently <strong>closed and deleted</strong> by the administrative team.<br><br>This decision is final.</p>`;
  }

  const emailHtml = `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; padding: 0; background-color: #000000; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrapper { width: 100%; table-layout: fixed; background-color: #000000; padding: 40px 0; }
  .container { max-width: 600px; margin: 0 auto; background: #09090b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 0 60px rgba(74, 222, 128, 0.05); }
  .header { padding: 40px 20px; text-align: center; border-bottom: 1px solid #18181b; background: radial-gradient(circle at top, ${headerColor} 0%, #09090b 100%); }
  .logo { max-width: 140px; margin-bottom: 20px; }
  .header h1 { margin: 0; color: ${titleColor}; font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
  .content { padding: 40px 40px; text-align: center; }
  .content p { color: #a1a1aa; font-size: 16px; line-height: 1.6; margin-bottom: 30px; }
  .footer { padding: 30px 20px; text-align: center; border-top: 1px solid #18181b; color: #52525b; font-size: 12px; background: #000000; }
  .highlight { color: #ffffff; font-weight: 600; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <img src="https://schwadevelopment.com.tr/logo.png" alt="Schwa" class="logo">
        <h1>${title}</h1>
      </div>
      <div class="content">
        ${contentHtml}
      </div>
      <div class="footer">
        © 2026 Schwa Development. All rights reserved.
      </div>
    </div>
  </div>
</body>
</html>`;

  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SMTP_PASS.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Schwa Scanner <noreply@schwadevelopment.com.tr>',
      to: application.email,
      subject: subject,
      html: emailHtml
    })
  }).catch(err => console.error("Email API Error:", err));
}

// Basit admin auth middleware
const adminAuth = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
};

router.use(adminAuth);

// GET /api/admin/users
router.get('/users', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can view users.' });
    }

    // Fetch ALL platform users (which have 16-char IDs or have an email/password) except the master 'schwa' key
    const customers = db.prepare("SELECT * FROM keys WHERE label != 'schwa' AND (LENGTH(id) = 16 OR email IS NOT NULL) ORDER BY createdAt DESC").all();
    
    // For each customer, find their latest scan's IP address
    const usersWithIp = customers.map(c => {
      const lastScan = db.prepare('SELECT ip_address FROM scans WHERE id = ? ORDER BY scanned_at DESC LIMIT 1').get(c.id);
      return {
        ...c,
        lastIp: lastScan ? lastScan.ip_address : null,
        active: c.active === 1
      };
    });

    const applications = db.prepare('SELECT * FROM applications ORDER BY created_at DESC').all();

    res.json({ users: usersWithIp, applications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/users/:id/password
router.post('/users/:id/password', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god') {
      return res.status(403).json({ error: 'Only God can change passwords.' });
    }
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'Password required.' });

    const stmt = db.prepare('UPDATE keys SET password = ? WHERE id = ?');
    stmt.run(newPassword, req.params.id);

    // Audit log
    const auditStmt = db.prepare('INSERT INTO audit_logs (admin_username, action, target, details) VALUES (?, ?, ?, ?)');
    auditStmt.run(req.headers['x-username'] || 'Unknown', 'CHANGE_PASSWORD', req.params.id, `Changed password to ${newPassword}`);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/keys
router.get('/keys', (req, res) => {
  try {
    const role = req.headers['x-role'];
    const username = req.headers['x-username'];

    let query = 'SELECT * FROM keys WHERE LENGTH(id) != 16 AND email IS NULL ORDER BY createdAt DESC';
    let params = [];

    if (role !== 'god' && role !== 'admin') {
      if (!username) return res.status(403).json({ error: 'Username required for authorized users.' });
      query = 'SELECT * FROM keys WHERE createdBy = ? AND LENGTH(id) != 16 AND email IS NULL ORDER BY createdAt DESC';
      params = [username];
    }

    const keys = db.prepare(query).all(...params);
    // Convert active (1/0) back to boolean
    const formattedKeys = keys.map(k => ({
      ...k,
      active: k.active === 1
    }));
    res.json(formattedKeys);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/keys
router.post('/keys', (req, res) => {
  const { id, game, label, createdBy, createdAt, expiresAt, active, maxUses, currentUses, notes, imageUrl } = req.body;
  try {
    const stmt = db.prepare(`
      INSERT INTO keys (id, game, label, createdBy, createdAt, expiresAt, active, maxUses, currentUses, notes, imageUrl) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id, game, label, createdBy, createdAt, expiresAt, 
      active ? 1 : 0, maxUses || 1, currentUses || 0, notes || '', imageUrl || ''
    );
    
    const adminUsername = req.headers['x-username'] || createdBy;
    logAudit(adminUsername, 'KEY_CREATED', label || id, `Created key for game: ${game}, max uses: ${maxUses || 1}`);
    
    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/admin/keys/:id
router.put('/keys/:id', (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const role = req.headers['x-role'];
  const username = req.headers['x-username'];
  
  try {
    if (role !== 'god' && role !== 'admin') {
      const keyRecord = db.prepare('SELECT createdBy FROM keys WHERE id = ?').get(id);
      if (!keyRecord || keyRecord.createdBy !== username) {
        return res.status(403).json({ error: 'You do not have permission to modify this key.' });
      }
    }

    const setClauses = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      if (['active', 'label', 'notes', 'maxUses', 'currentUses', 'imageUrl'].includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(key === 'active' ? (value ? 1 : 0) : value);
      }
    }
    
    if (setClauses.length === 0) return res.json({ success: true });
    
    // Send email logic for customers
    if (id.length === 16 && updates.hasOwnProperty('active')) {
      const currentRecord = db.prepare('SELECT active, label FROM keys WHERE id = ?').get(id);
      if (currentRecord && currentRecord.active !== (updates.active ? 1 : 0)) {
        const action = updates.active ? 'reactivated' : 'frozen';
        sendCustomerEmail(currentRecord.label, action);
      }
    }

    const oldUser = db.prepare('SELECT label FROM keys WHERE id = ?').get(id);
    
    values.push(id);
    const stmt = db.prepare(`UPDATE keys SET ${setClauses.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    
    // Sync username change to team_members
    if (updates.label && oldUser && oldUser.label && oldUser.label !== updates.label) {
      try {
        db.prepare('UPDATE team_members SET username = ? WHERE username = ? COLLATE NOCASE').run(updates.label, oldUser.label);
        db.prepare('UPDATE teams SET leader_username = ? WHERE leader_username = ? COLLATE NOCASE').run(updates.label, oldUser.label);
      } catch(e) {
        console.error("Failed to sync username to team components:", e);
      }
    }
    
    logAudit(username || 'Unknown', 'KEY_UPDATED', oldUser ? oldUser.label : id, `Updated fields: ${Object.keys(updates).join(', ')}`);
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/admin/keys/:id
router.delete('/keys/:id', (req, res) => {
  try {
    const { id } = req.params;
    const role = req.headers['x-role'];
    const username = req.headers['x-username'];

    if (role !== 'god' && role !== 'admin') {
      const keyRecord = db.prepare('SELECT createdBy FROM keys WHERE id = ?').get(id);
      if (!keyRecord || keyRecord.createdBy !== username) {
        return res.status(403).json({ error: 'You do not have permission to delete this key.' });
      }
    }

    if (id.length === 16) {
      const customer = db.prepare('SELECT label FROM keys WHERE id = ?').get(id);
      if (customer) sendCustomerEmail(customer.label, 'closed');
    }

    const deletedKey = db.prepare('SELECT label FROM keys WHERE id = ?').get(id);
    db.prepare('DELETE FROM scans WHERE id = ?').run(id); // Delete associated scans first
    db.prepare('DELETE FROM keys WHERE id = ?').run(id);
    
    logAudit(username || 'Unknown', 'KEY_DELETED', deletedKey ? deletedKey.label : id, `Deleted key ${id}`);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/scans
router.get('/scans', (req, res) => {
  try {
    const role = req.headers['x-role'];
    const username = req.headers['x-username'];

    let scans = [];
    if (role === 'god') {
      // God sees all scans
      scans = db.prepare('SELECT scans.*, keys.createdBy as createdBy, keys.label as keyLabel FROM scans LEFT JOIN keys ON scans.id = keys.id ORDER BY scans.scanned_at DESC').all();
    } else {
      // Admins and users only see scans for keys they created/own
      if (!username) return res.status(403).json({ error: 'Username required' });
      const userKeys = db.prepare('SELECT id FROM keys WHERE createdBy = ?').all(username).map(k => k.id);
      if (userKeys.length > 0) {
        const placeholders = userKeys.map(() => '?').join(',');
        scans = db.prepare(`SELECT scans.*, keys.createdBy as createdBy, keys.label as keyLabel FROM scans LEFT JOIN keys ON scans.id = keys.id WHERE scans.id IN (${placeholders}) ORDER BY scans.scanned_at DESC`).all(...userKeys);
      }
    }

    const formattedScans = scans.map(s => {
      let parsedResults = [];
      try {
        let rawParsed = JSON.parse(s.results_json);
        if (Array.isArray(rawParsed)) {
          parsedResults = rawParsed;
        } else if (rawParsed && Array.isArray(rawParsed.findings)) {
          parsedResults = rawParsed.findings;
        } else if (rawParsed && typeof rawParsed === 'object') {
          parsedResults = [rawParsed];
        }
      } catch (e) {
        parsedResults = [];
      }
      
      let riskScore = 0;
      let suspiciousCount = 0;
      let cleanCount = 0;
      let warningCount = 0;
      let criticalCount = 0;

      const findings = parsedResults.map(f => {
        // Fallback for old schema
        const sev = f.severity || f.seviye || 'INFO';
        const sevUpper = sev.toUpperCase();
        
        let mappedSeverity = 'INFO';
        if (sevUpper === 'CRITICAL') { mappedSeverity = 'CRITICAL'; criticalCount++; }
        else if (sevUpper === 'HIGH') { mappedSeverity = 'HIGH'; suspiciousCount++; }
        else if (sevUpper === 'MEDIUM' || sevUpper === 'WARNING') { mappedSeverity = 'MEDIUM'; warningCount++; }
        else if (sevUpper === 'LOW') { mappedSeverity = 'LOW'; }
        else if (sevUpper === 'CLEAN') { mappedSeverity = 'CLEAN'; cleanCount++; }
        else { mappedSeverity = 'INFO'; }

        // Risk Score calculation based on AI Confidence and Severity
        const confidence = typeof f.confidence === 'number' ? f.confidence : 100;
        let riskWeight = 0;
        if (mappedSeverity === 'CRITICAL') riskWeight = 30;
        if (mappedSeverity === 'HIGH') riskWeight = 20;
        if (mappedSeverity === 'MEDIUM') riskWeight = 10;
        if (mappedSeverity === 'LOW') riskWeight = 2;
        
        // Combine confidence into the risk factor
        const actualRisk = riskWeight * (confidence / 100);
        riskScore += actualRisk;

        return {
          id: Math.random().toString(36).substr(2, 9),
          category: f.category || 'system',
          severity: mappedSeverity,
          title: f.title || f.modul || 'Bilinmeyen Bulgu',
          details: f.details || f.detay || '',
          evidence: f.evidence || f.kanit || '',
          location: f.location || f.konum || '',
          confidence: confidence
        };
      });

      // Cap Risk Score at 100
      riskScore = Math.min(100, Math.round(riskScore));

      let verdict = 'Clean';
      if (riskScore >= 80 || criticalCount > 0) verdict = 'Critical Risk';
      else if (riskScore >= 60) verdict = 'High Risk';
      else if (riskScore >= 30) verdict = 'Suspicious';
      else if (riskScore > 0) verdict = 'Low Risk';

      return {
        id: s.scan_id ? s.scan_id.toString() : s.id.toString(), // Admin app scan id
        keyId: s.id, // Admin app uses keyId
        createdBy: s.createdBy || 'Bilinmiyor',
        keyLabel: s.keyLabel || '',
        gameId: s.game || 'Bilinmiyor',
        timestamp: s.scanned_at,
        endTime: s.scanned_at,
        duration: 15, // fake duration
        verdict: verdict,
        riskScore: riskScore,
        stats: {
          totalFindings: findings.length,
          cleanCount: cleanCount,
          warningCount: warningCount,
          suspiciousCount: suspiciousCount,
          criticalCount: criticalCount,
          stagesCompleted: 11,
          totalStages: 11,
          filesScanned: 1000
        },
        findings: findings
      };
    });
    res.json(formattedScans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/applications
router.get('/applications', (req, res) => {
  try {
    const applications = db.prepare('SELECT * FROM applications ORDER BY created_at DESC').all();
    res.json(applications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/applications/:id/respond
router.post('/applications/:id/respond', async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  try {
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    if (!application) return res.status(404).json({ error: 'Not found' });
    if (application.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    const isApprove = action === 'approve';
    const newStatus = isApprove ? 'approved' : 'rejected';
    
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(newStatus, id);

    const adminUsername = req.headers['x-username'] || 'Unknown';
    logAudit(adminUsername, `APP_${newStatus.toUpperCase()}`, application.username, `Responded to application for ${application.username}`);

    // Generate key if approving (same logic as /api/respond in server.js)
    let generatedKey = null;
    if (isApprove) {
      const crypto = require('crypto');
      const generatePassword = (length) => {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        const randomBytes = crypto.randomBytes(length);
        for (let i = 0; i < length; i++) {
          result += chars[randomBytes[i] % chars.length];
        }
        return result;
      };
      generatedKey = generatePassword(16);

      let discordAvatarUrl = '';
      if (application.discord && process.env.OSINT_TOKEN) {
        try {
          const apiRes = await axios.get(`https://discord.com/api/v10/users/${application.discord}`, {
            headers: { Authorization: `Bot ${process.env.OSINT_TOKEN}` },
            validateStatus: false
          });
          if (apiRes.status === 200 && apiRes.data.avatar) {
            const ext = apiRes.data.avatar.startsWith('a_') ? 'gif' : 'png';
            discordAvatarUrl = `https://cdn.discordapp.com/avatars/${application.discord}/${apiRes.data.avatar}.${ext}?size=1024`;
          }
        } catch (e) {
          console.error("Discord avatar fetch error:", e.message);
        }
      }

      db.prepare(`
        INSERT INTO keys (id, game, label, createdBy, createdAt, active, maxUses, currentUses, imageUrl, discord_id, email) 
        VALUES (?, 'System', ?, 'Admin', datetime('now'), 1, 1, 0, ?, ?, ?)
      `).run(generatedKey, application.username, discordAvatarUrl, application.discord, application.email);
    }

    // Send email via Resend API
    if (application.email && process.env.SMTP_PASS) {
      const emailHtml = isApprove ? `
      <!DOCTYPE html><html><head><style>
        body { margin: 0; padding: 0; background-color: #000000; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .wrapper { width: 100%; table-layout: fixed; background-color: #000000; padding: 40px 0; }
        .container { max-width: 600px; margin: 0 auto; background: #09090b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; }
        .header { padding: 40px 20px; text-align: center; border-bottom: 1px solid #18181b; background: radial-gradient(circle at top, #052e16 0%, #09090b 100%); }
        .logo { max-width: 140px; margin-bottom: 20px; }
        .header h1 { margin: 0; color: #4ade80; font-size: 26px; font-weight: 700; }
        .content { padding: 40px; text-align: center; }
        .content p { color: #a1a1aa; font-size: 16px; line-height: 1.6; }
        .highlight { color: #ffffff; font-weight: 600; }
        .key-container { background: #000; border: 1px solid #22c55e40; border-radius: 12px; padding: 20px; margin: 24px 0; }
        .label { display: block; color: #4ade80; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px; }
        .key { display: block; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: 3px; font-family: 'Courier New', monospace; }
        .footer { padding: 30px 20px; text-align: center; border-top: 1px solid #18181b; color: #52525b; font-size: 12px; background: #000000; }
      </style></head><body>
        <div class="wrapper"><div class="container">
          <div class="header">
            <img src="https://schwadevelopment.com.tr/logo.png" alt="Schwa" class="logo">
            <h1>Access Granted</h1>
          </div>
          <div class="content">
            <p>Hello <span class="highlight">${application.username}</span>,<br><br>Your application for <strong>Schwa Scanner</strong> has been officially approved by our administrative team.</p>
            <div class="key-container">
              <span class="label">Your Unique License Key</span>
              <span class="key">${generatedKey}</span>
            </div>
            <p style="font-size: 14px; color: #71717a;">Please keep this key secure. You will use it to authenticate your software.</p>
          </div>
          <div class="footer">© 2026 Schwa Development. All rights reserved.</div>
        </div></div>
      </body></html>` : `
      <!DOCTYPE html><html><head><style>
        body { margin: 0; padding: 0; background-color: #000000; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
        .wrapper { width: 100%; table-layout: fixed; background-color: #000000; padding: 40px 0; }
        .container { max-width: 600px; margin: 0 auto; background: #09090b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; }
        .header { padding: 40px 20px; text-align: center; border-bottom: 1px solid #18181b; background: radial-gradient(circle at top, #450a0a 0%, #09090b 100%); }
        .logo { max-width: 140px; margin-bottom: 20px; }
        .header h1 { margin: 0; color: #f87171; font-size: 26px; font-weight: 700; }
        .content { padding: 40px; text-align: center; }
        .content p { color: #a1a1aa; font-size: 16px; line-height: 1.6; }
        .highlight { color: #ffffff; font-weight: 600; }
        .footer { padding: 30px 20px; text-align: center; border-top: 1px solid #18181b; color: #52525b; font-size: 12px; background: #000000; }
      </style></head><body>
        <div class="wrapper"><div class="container">
          <div class="header">
            <img src="https://schwadevelopment.com.tr/logo.png" alt="Schwa" class="logo">
            <h1>Application Denied</h1>
          </div>
          <div class="content">
            <p>Hello <span class="highlight">${application.username}</span>,<br><br>After careful review, we regret to inform you that your application for <strong>Schwa Scanner</strong> has not been approved at this time.</p>
          </div>
          <div class="footer">© 2026 Schwa Development. All rights reserved.</div>
        </div></div>
      </body></html>`;

      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SMTP_PASS.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Schwa Scanner <noreply@schwadevelopment.com.tr>',
          to: application.email,
          subject: isApprove ? 'Your Schwa Scanner Application is Approved!' : 'Schwa Scanner Application Update',
          html: emailHtml
        })
      }).catch(err => console.error("Email API Error:", err));
    }

    // Discord webhook with key info
    const webhookUrl = null; // process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: isApprove 
            ? `✅ **Application Approved:** <@${application.discord}> (Username: **${application.username}**) has been granted access!\n🔑 A unique license key (\`${generatedKey}\`) was automatically generated and emailed to **${application.email}**.` 
            : `❌ **Application Rejected:** **${application.username}**'s access request was denied.\nAn email notification has been sent to **${application.email}**.`,
          embeds: [{
            title: isApprove ? "Access Granted" : "Access Denied",
            color: isApprove ? 3066993 : 15158332,
            description: isApprove 
              ? `The application for **${application.username}** has been reviewed and approved.` 
              : `The application for **${application.username}** has been reviewed and rejected.`,
            timestamp: new Date().toISOString()
          }]
        })
      });
    }

    res.json({ success: true, newStatus, generatedKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/keys
router.get('/keys', (req, res) => {
  try {
    const role = req.headers['x-role'];
    const username = req.headers['x-username'];

    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let keys;
    if (role === 'god') {
      // God panel sees everything
      keys = db.prepare('SELECT * FROM keys ORDER BY createdAt DESC').all();
    } else {
      // Admins only see keys they created
      keys = db.prepare('SELECT * FROM keys WHERE createdBy = ? ORDER BY createdAt DESC').all(username);
    }
    
    res.json(keys);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
// POST /api/admin/users/:id/role
router.post('/users/:id/role', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god') {
      return res.status(403).json({ error: 'Only God can change roles.' });
    }

    const { id } = req.params;
    const { newRole } = req.body;

    if (!['god', 'admin', 'member', 'viewer'].includes(newRole)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }

    const user = db.prepare('SELECT label FROM keys WHERE id = ?').get(id);
    db.prepare('UPDATE keys SET role = ? WHERE id = ?').run(newRole, id);
    
    const adminUsername = req.headers['x-username'] || 'Unknown';
    logAudit(adminUsername, 'ROLE_CHANGED', user ? user.label : id, `Role changed to ${newRole}`);
    
    if (user && user.label) {
      try {
        db.prepare('UPDATE team_members SET role = ? WHERE username = ? COLLATE NOCASE').run(newRole, user.label);
      } catch(e) {
        console.error("Failed to update role in team_members", e);
      }
    }
    
    res.json({ success: true, message: 'Role updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/users/:id/flair
router.post('/users/:id/flair', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god') {
      return res.status(403).json({ error: 'Only God can manage profile flair.' });
    }

    const { id } = req.params;
    const { badges, profile_effect } = req.body;
    const allowedEffects = ['none', 'glow', 'pulse', 'spark', 'rainbow', 'inferno', 'frost', 'hologram', 'nebula', 'prism', 'cyber', 'royal', 'vortex'];
    const nextBadges = normalizeBadges(badges);
    const nextEffect = allowedEffects.includes(profile_effect) ? profile_effect : 'none';

    const user = db.prepare('SELECT label FROM keys WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    db.prepare('UPDATE keys SET badges = ?, profile_effect = ? WHERE id = ?').run(
      JSON.stringify(nextBadges),
      nextEffect,
      id
    );

    const adminUsername = req.headers['x-username'] || 'Unknown';
    logAudit(adminUsername, 'PROFILE_FLAIR_UPDATED', user.label || id, `Badges: ${nextBadges.map(b => b.label).join(', ') || 'none'}, effect: ${nextEffect}`);

    res.json({ success: true, badges: nextBadges, profile_effect: nextEffect });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/badge-presets
router.get('/badge-presets', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Permission denied.' });
    }
    const presets = db.prepare('SELECT * FROM badge_presets ORDER BY created_at DESC').all();
    res.json({ success: true, presets });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/badge-presets
router.post('/badge-presets', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god') {
      return res.status(403).json({ error: 'Only God can manage badge presets.' });
    }
    const [badge] = normalizeBadges([req.body]);
    if (!badge) return res.status(400).json({ error: 'Badge label required.' });

    const info = db.prepare('INSERT INTO badge_presets (label, color, icon, created_by) VALUES (?, ?, ?, ?)').run(
      badge.label,
      badge.color || '#38bdf8',
      badge.icon || '',
      req.headers['x-username'] || 'Unknown'
    );
    const preset = db.prepare('SELECT * FROM badge_presets WHERE id = ?').get(info.lastInsertRowid);
    logAudit(req.headers['x-username'] || 'Unknown', 'BADGE_PRESET_CREATED', preset.label, `Created badge preset ${preset.label}`);
    res.json({ success: true, preset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/admin/badge-presets/:id
router.delete('/badge-presets/:id', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god') {
      return res.status(403).json({ error: 'Only God can manage badge presets.' });
    }
    const preset = db.prepare('SELECT * FROM badge_presets WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM badge_presets WHERE id = ?').run(req.params.id);
    logAudit(req.headers['x-username'] || 'Unknown', 'BADGE_PRESET_DELETED', preset ? preset.label : req.params.id, 'Deleted badge preset');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});
// GET /api/admin/false-positives
router.get('/false-positives', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Permission denied.' });
    }
    const fps = db.prepare('SELECT * FROM false_positives ORDER BY created_at DESC').all();
    res.json(fps);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/admin/false-positives/:id/status
router.put('/false-positives/:id/status', (req, res) => {
  try {
    const role = req.headers['x-role'];
    const adminUsername = req.headers['x-username'] || 'Unknown Admin';
    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Permission denied.' });
    }

    const { id } = req.params;
    const { status } = req.body; // 'approved' or 'rejected'

    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const fp = db.prepare('SELECT * FROM false_positives WHERE id = ?').get(id);
    if (!fp) return res.status(404).json({ error: 'Not found' });

    db.prepare('UPDATE false_positives SET status = ?, reviewed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, adminUsername, id);

    logAudit(adminUsername, `FP_${status.toUpperCase()}`, fp.file_path, fp.reason);

    // If approved, add to whitelist
    if (status === 'approved') {
      try {
        db.prepare('INSERT OR IGNORE INTO whitelist (keyword, added_by) VALUES (?, ?)').run(fp.file_path, adminUsername);
      } catch (e) {
        console.error('Failed to add to whitelist', e);
      }
    } else if (status === 'rejected' && fp.status === 'approved') {
      // If it was previously approved and is now rejected, remove from whitelist
      try {
        db.prepare('DELETE FROM whitelist WHERE keyword = ?').run(fp.file_path);
      } catch (e) {
        console.error('Failed to remove from whitelist', e);
      }
    }

    res.json({ success: true, message: `Status updated to ${status}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/whitelist
router.get('/whitelist', (req, res) => {
  try {
    // This could be open or require auth depending on how the scanner fetches it.
    // Making it open for the scanner to fetch easily.
    const items = db.prepare('SELECT keyword FROM whitelist').all();
    const keywords = items.map(item => item.keyword);
    res.json({ keywords });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/audit-logs
router.get('/audit-logs', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god') return res.status(403).json({ error: 'Only God can view audit logs' });
    const logs = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500').all();
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
