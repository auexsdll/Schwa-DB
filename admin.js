const express = require('express');
const router = express.Router();
const db = require('../database');

// Basit admin auth middleware
const adminAuth = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
};

router.use(adminAuth);

// GET /api/admin/keys
router.get('/keys', (req, res) => {
  try {
    const keys = db.prepare('SELECT * FROM keys ORDER BY createdAt DESC').all();
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
  const updates = req.body; // Örn: { active: false }
  
  try {
    const setClauses = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      if (['active', 'label', 'notes', 'maxUses', 'currentUses', 'imageUrl'].includes(key)) {
        setClauses.push(`${key} = ?`);
        values.push(key === 'active' ? (value ? 1 : 0) : value);
      }
    }
    
    if (setClauses.length === 0) return res.json({ success: true });
    
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
    const scans = db.prepare('SELECT * FROM scans ORDER BY scanned_at DESC').all();
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
