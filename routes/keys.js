const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../database');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');

const verifyLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { valid: false, message: 'Çok fazla deneme yaptınız, lütfen daha sonra tekrar deneyin.' }
});

router.post('/verify', verifyLimiter, (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ valid: false, message: 'Key gereklidir' });
  }

  // Frontend'den gelen tireleri silinmiş key'i veritabanı formatına çevir
  let formattedKey = key;
  if (!key.includes('-') && key.startsWith('SCHWA') && key.length === 17) {
    formattedKey = `SCHWA-${key.substring(5, 9)}-${key.substring(9, 13)}-${key.substring(13, 17)}`;
  }

  try {
    const stmt = db.prepare('SELECT * FROM keys WHERE id = ?');
    const keyRecord = stmt.get(formattedKey);

    if (!keyRecord) {
      return res.status(404).json({ valid: false, message: 'Geçersiz veya bulunamayan key' });
    }

    if (keyRecord.active !== 1) {
      return res.status(400).json({ valid: false, message: 'Bu key devre dışı bırakılmış' });
    }

    if (keyRecord.currentUses >= keyRecord.maxUses) {
      return res.status(400).json({ valid: false, message: 'Bu keyin kullanım limiti dolmuş' });
    }

    if (new Date(keyRecord.expiresAt) < new Date()) {
      return res.status(400).json({ valid: false, message: 'Bu keyin süresi dolmuş' });
    }

    const token = jwt.sign(
      { id: keyRecord.id },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    return res.json({ valid: true, token, imageUrl: keyRecord.imageUrl });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ valid: false, message: 'Sunucu hatası' });
  }
});

router.post('/activate', authMiddleware, (req, res) => {
  const { key, game } = req.body;
  const decodedKey = req.user.id;

  if (key !== decodedKey) {
    return res.status(403).json({ success: false, message: 'Token bu key için geçerli değil' });
  }

  if (!game) {
    return res.status(400).json({ success: false, message: 'Oyun seçimi gereklidir' });
  }

  try {
    const keyRecord = db.prepare('SELECT * FROM keys WHERE id = ?').get(key);
    
    if (!keyRecord || keyRecord.active !== 1 || keyRecord.currentUses >= keyRecord.maxUses || new Date(keyRecord.expiresAt) < new Date()) {
       return res.status(400).json({ success: false, message: 'Key aktifleştirilemedi (süresi veya limiti dolmuş olabilir)' });
    }

    // Oyun türü eşleşiyor mu kontrol edilebilir (Admin belli bir oyun için verdiyse). Admin app "game" objesini veriyor.
    // Şimdilik client oyun seçimiyle update edelim (ya da adminin seçtiği oyunla eşleşiyorsa izin verelim).
    // Admin app "game" değerini atıyor.
    if (keyRecord.game !== game) {
      return res.status(400).json({ success: false, message: 'Bu key seçtiğiniz oyun için geçerli değil.' });
    }

    const updateStmt = db.prepare('UPDATE keys SET currentUses = currentUses + 1 WHERE id = ?');
    const result = updateStmt.run(key);

    if (result.changes === 0) {
      return res.status(400).json({ success: false, message: 'Key aktifleştirilemedi' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: 'Sunucu hatası' });
  }
});
// Update Profile
router.post('/update-profile', async (req, res) => {
  const { key, email, discord_id } = req.body;
  if (!key) return res.status(400).json({ success: false, message: 'Key required' });

  try {
    const user = db.prepare('SELECT * FROM keys WHERE id = ?').get(key);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    let imageUrl = user.imageUrl;

    if (discord_id && discord_id !== user.discord_id) {
      if (process.env.OSINT_TOKEN) {
        try {
          const axios = require('axios');
          const apiRes = await axios.get(`https://discord.com/api/v10/users/${discord_id}`, {
            headers: { Authorization: `Bot ${process.env.OSINT_TOKEN}` },
            validateStatus: false
          });
          if (apiRes.status === 200 && apiRes.data.avatar) {
            const ext = apiRes.data.avatar.startsWith('a_') ? 'gif' : 'png';
            imageUrl = `https://cdn.discordapp.com/avatars/${discord_id}/${apiRes.data.avatar}.${ext}?size=1024`;
          }
        } catch (e) {
          console.error("Discord avatar fetch error:", e.message);
        }
      }
    }

    db.prepare('UPDATE keys SET email = ?, discord_id = ?, imageUrl = ? WHERE id = ?').run(email || user.email, discord_id || user.discord_id, imageUrl, key);
    
    // Also update team_members table
    db.prepare('UPDATE team_members SET email = ?, discord_id = ? WHERE username = ? COLLATE NOCASE').run(email || user.email, discord_id || user.discord_id, user.label);

    res.json({ success: true, message: 'Profile updated successfully', imageUrl });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get Profile
router.get('/profile', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!key) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const user = db.prepare('SELECT email, discord_id, imageUrl FROM keys WHERE id = ?').get(key);
  res.json({ success: true, profile: user });
});

module.exports = router;

