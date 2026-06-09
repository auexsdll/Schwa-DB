const express = require('express');
const router = express.Router();
const db = require('../database');
const authMiddleware = require('../middleware/auth');

// In-memory store for live scan progress
const liveScans = new Map();

// POST /api/scan/progress - Client sends progress updates
router.post('/progress', authMiddleware, (req, res) => {
  const { key, progress, message, findings, stage } = req.body;
  const decodedKey = req.user.id;

  if (key !== decodedKey) {
    return res.status(403).json({ success: false, message: 'Token bu key için geçerli değil' });
  }

  liveScans.set(key, {
    progress,
    message,
    findings: findings || [],
    stage: stage || '',
    lastUpdated: Date.now()
  });

  res.json({ success: true });
});

// GET /api/scan/live/:keyId - Admin fetches live progress
router.get('/live/:keyId', (req, res) => {
  // We can add admin auth here if needed, but for now we just return the data
  const { keyId } = req.params;
  const data = liveScans.get(keyId);
  
  if (!data) {
    // Check if it's too old or doesn't exist
    return res.json({ active: false });
  }

  // If last updated more than 30 seconds ago, consider it dead/finished
  if (Date.now() - data.lastUpdated > 30000) {
    liveScans.delete(keyId);
    return res.json({ active: false });
  }

  res.json({ active: true, ...data });
});

router.post('/submit', authMiddleware, (req, res) => {
  const { key, game, results } = req.body;
  const decodedKey = req.user.id;

  if (key !== decodedKey) {
    return res.status(403).json({ success: false, message: 'Token bu key için geçerli değil' });
  }

  try {
    const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const resultsJson = JSON.stringify(results || []);

    const insertStmt = db.prepare('INSERT INTO scans (id, game, results_json, ip_address) VALUES (?, ?, ?, ?)');
    insertStmt.run(key, game, resultsJson, ip_address);
    
    // Look for Discord info finding to update the key
    if (results && Array.isArray(results)) {
      const discordFinding = results.find(f => f.modul === 'Discord' || f.type === 'discord');
      if (discordFinding && discordFinding.kanit) {
        // Expected kanit format: Kullanıcı: <username>\nTahmini ID: <id>\n...
        const lines = discordFinding.kanit.split('\n');
        let username = null;
        let idStr = null;
        for (const line of lines) {
          if (line.startsWith('Kullanıcı:')) username = line.replace('Kullanıcı:', '').trim();
          if (line.startsWith('Tahmini ID:')) idStr = line.replace('Tahmini ID:', '').trim();
        }
        
        if (username || idStr) {
          const updateKeyStmt = db.prepare('UPDATE keys SET discordId = ?, discordUsername = ? WHERE id = ?');
          updateKeyStmt.run(idStr || null, username || null, key);
        }
      }
    }

    // Clear live scan once submitted
    liveScans.delete(key);

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false });
  }
});

module.exports = router;
