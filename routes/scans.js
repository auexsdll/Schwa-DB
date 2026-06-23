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

  let filteredFindings = findings || [];
  try {
    const whitelistRows = db.prepare('SELECT keyword FROM whitelist').all();
    const whitelistKeywords = whitelistRows.map(row => row.keyword.toLowerCase());
    
    if (Array.isArray(filteredFindings) && whitelistKeywords.length > 0) {
      filteredFindings = filteredFindings.filter(f => {
        const checkStr = ((f.detay || '') + ' ' + (f.kanit || '') + ' ' + (f.konum || '')).toLowerCase();
        return !whitelistKeywords.some(keyword => checkStr.includes(keyword));
      });
    }
  } catch (e) {
    console.error('Progress whitelist filtering error:', e);
  }

  liveScans.set(key, {
    progress,
    message,
    findings: filteredFindings,
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
  const { key, game, results, reason, aborted } = req.body;
  const decodedKey = req.user.id;

  if (key !== decodedKey) {
    return res.status(403).json({ success: false, message: 'Token bu key için geçerli değil' });
  }

  try {
    const ip_address = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    let filteredResults = results || [];
    try {
      const whitelistRows = db.prepare('SELECT keyword FROM whitelist').all();
      const whitelistKeywords = whitelistRows.map(row => row.keyword.toLowerCase());
      
      if (Array.isArray(filteredResults) && whitelistKeywords.length > 0) {
        filteredResults = filteredResults.filter(f => {
          const checkStr = ((f.detay || '') + ' ' + (f.kanit || '') + ' ' + (f.konum || '')).toLowerCase();
          return !whitelistKeywords.some(keyword => checkStr.includes(keyword));
        });
      }
    } catch (e) {
      console.error('Submit whitelist filtering error:', e);
    }

    // reason ve aborted bilgisini results ile birlikte kaydet
    const scanData = {
      results: filteredResults,
      reason: reason || 'completed',   // completed | user_closed | crash | bypass_detected
      aborted: aborted || false
    };
    const resultsJson = JSON.stringify(scanData);

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

// GET /api/scan/public/:pin - Public endpoint for clients to view their results
router.get('/public/:pin', (req, res) => {
  const { pin } = req.params;
  
  if (!pin || pin.length !== 6) {
    return res.status(400).json({ success: false, message: 'Geçersiz PIN formatı.' });
  }

  try {
    // Check if PIN exists
    const keyRecord = db.prepare('SELECT * FROM keys WHERE id = ?').get(pin);
    
    if (!keyRecord) {
      return res.status(404).json({ success: false, message: 'Bu PIN kodu bulunamadı veya geçersiz.' });
    }

    // Check if there is a completed scan
    const scanRecord = db.prepare('SELECT * FROM scans WHERE id = ? ORDER BY scanned_at DESC LIMIT 1').get(pin);

    // Also check if there's a live scan currently running
    const liveData = liveScans.get(pin);
    const isLiveActive = liveData && (Date.now() - liveData.lastUpdated <= 30000);

    if (scanRecord) {
      // Completed
      return res.json({
        success: true,
        status: 'completed',
        game: scanRecord.game,
        scanned_at: scanRecord.scanned_at,
        results: JSON.parse(scanRecord.results_json || '[]')
      });
    } else if (isLiveActive) {
      // Currently scanning
      return res.json({
        success: true,
        status: 'scanning',
        progress: liveData.progress,
        message: liveData.message,
        stage: liveData.stage
      });
    } else {
      // Waiting for client to start
      return res.json({
        success: true,
        status: 'pending',
        message: 'Tarama henüz başlamadı veya sonuçlar sisteme ulaşmadı.'
      });
    }

  } catch (error) {
    console.error("Public Scan API Hatası:", error);
    return res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
  }
});

// POST /api/scan/false-positive
router.post('/false-positive', async (req, res) => {
  const { scan_id, finding_id, file_path, reason, user_id } = req.body;
  if (!file_path || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO false_positives (scan_id, user_id, file_path, finding_id, reason, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    stmt.run(scan_id || null, user_id || null, file_path, finding_id || null, reason);
    res.json({ success: true, message: 'False positive reported successfully' });
  } catch (error) {
    console.error('False positive insert error:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
