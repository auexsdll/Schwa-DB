const express = require('express');
const router = express.Router();
const db = require('../database');

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

    // Fetch keys with length 16 (customers)
    const customers = db.prepare('SELECT * FROM keys WHERE LENGTH(id) = 16 ORDER BY createdAt DESC').all();
    
    // For each customer, find their latest scan's IP address
    const usersWithIp = customers.map(c => {
      const lastScan = db.prepare('SELECT ip_address FROM scans WHERE id = ? ORDER BY scanned_at DESC LIMIT 1').get(c.id);
      return {
        ...c,
        lastIp: lastScan ? lastScan.ip_address : null,
        active: c.active === 1
      };
    });

    res.json(usersWithIp);
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

    let query = 'SELECT * FROM keys WHERE LENGTH(id) != 16 ORDER BY createdAt DESC';
    let params = [];

    if (role !== 'god' && role !== 'admin') {
      if (!username) return res.status(403).json({ error: 'Username required for authorized users.' });
      query = 'SELECT * FROM keys WHERE createdBy = ? AND LENGTH(id) != 16 ORDER BY createdAt DESC';
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

    values.push(id);
    const stmt = db.prepare(`UPDATE keys SET ${setClauses.join(', ')} WHERE id = ?`);
    stmt.run(...values);
    
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

    db.prepare('DELETE FROM scans WHERE id = ?').run(id); // Delete associated scans first
    db.prepare('DELETE FROM keys WHERE id = ?').run(id);
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
    if (role !== 'god' && role !== 'admin') {
      if (!username) return res.status(403).json({ error: 'Username required' });
      const userKeys = db.prepare('SELECT id FROM keys WHERE createdBy = ?').all(username).map(k => k.id);
      if (userKeys.length > 0) {
        const placeholders = userKeys.map(() => '?').join(',');
        scans = db.prepare(`SELECT * FROM scans WHERE id IN (${placeholders}) ORDER BY scanned_at DESC`).all(...userKeys);
      }
    } else {
      scans = db.prepare('SELECT * FROM scans ORDER BY scanned_at DESC').all();
    }

    const formattedScans = scans.map(s => {
      let parsedResults = [];
      try {
        parsedResults = JSON.parse(s.results_json);
      } catch (e) {}
      
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

    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: isApprove 
            ? `✅ **Application Approved:** <@${application.discord}> (Username: **${application.username}**) has been granted access!` 
            : `❌ **Application Rejected:** **${application.username}**'s access request was denied.`,
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

    res.json({ success: true, newStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
