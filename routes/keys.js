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

    // Fetch custom strings defined by the admin who created this PIN
    let customStrings = [];
    try {
      const strStmt = db.prepare('SELECT title, string, process FROM custom_strings WHERE createdBy = ?');
      customStrings = strStmt.all(keyRecord.createdBy);
    } catch (err) {
      console.error('Failed to fetch custom strings for PIN verification:', err);
    }

    const token = jwt.sign(
      { id: keyRecord.id },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    return res.json({ valid: true, token, imageUrl: keyRecord.imageUrl, customStrings });
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
  const { key, email, discord_id, avatar_url, banner_url, bio, profile_color } = req.body;
  if (!key) return res.status(400).json({ success: false, message: 'Key required' });

  try {
    let user = db.prepare('SELECT * FROM keys WHERE id = ?').get(key);
    
    // Auto-create master-key if it doesn't exist
    if (!user && key === 'master-key') {
      db.prepare(`
        INSERT INTO keys (id, game, label, createdBy, createdAt, expiresAt, active, maxUses, currentUses, role)
        VALUES ('master-key', 'all', 'schwa', 'system', datetime('now'), '2099-12-31T23:59:59.000Z', 1, 999999, 0, 'god')
      `).run();
      user = db.prepare('SELECT * FROM keys WHERE id = ?').get(key);
    }

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

    db.prepare(`
      UPDATE keys 
      SET email = ?, discord_id = ?, imageUrl = ?, avatar_url = ?, banner_url = ?, bio = ?, profile_color = ? 
      WHERE id = ?
    `).run(
      email || user.email, 
      discord_id || user.discord_id, 
      imageUrl, 
      avatar_url || user.avatar_url, 
      banner_url || user.banner_url, 
      bio || user.bio, 
      profile_color || user.profile_color, 
      key
    );
    
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
  let user = db.prepare('SELECT email, discord_id, imageUrl, avatar_url, banner_url, bio, profile_color FROM keys WHERE id = ?').get(key);
  
  if (!user && key === 'master-key') {
    user = { email: '', discord_id: '', imageUrl: null, avatar_url: null, banner_url: null, bio: null, profile_color: '#10b981' };
  }

  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, profile: user });
});

// Update user profile
router.post('/profile', authMiddleware, (req, res) => {
  const { avatar_url, banner_url, bio, profile_color, social_link } = req.body;
  const userId = req.user.id;

  try {
    const stmt = db.prepare(`
      UPDATE keys 
      SET avatar_url = COALESCE(?, avatar_url),
          banner_url = COALESCE(?, banner_url),
          bio = COALESCE(?, bio),
          profile_color = COALESCE(?, profile_color),
          social_link = COALESCE(?, social_link)
      WHERE id = ?
    `);
    
    stmt.run(avatar_url, banner_url, bio, profile_color, social_link, userId);
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update profile' });
  }
});

// Get user profile
router.get('/profile/:id', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT id, game, label, createdBy, createdAt, discord_id, email, role, avatar_url, banner_url, bio, profile_color, social_link, active
      FROM keys WHERE label = ? COLLATE NOCASE
    `);
    const user = stmt.get(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Also fetch team info
    const teamStmt = db.prepare(`
      SELECT tm.role as team_role, tm.custom_role, t.name, t.logo_url, t.description, t.color
      FROM team_members tm
      JOIN teams t ON tm.team_id = t.id
      WHERE tm.username = ? COLLATE NOCASE
    `);
    const team = teamStmt.get(user.label);
    
    res.json({ success: true, user: { ...user, team: team || null } });
  } catch (error) {
    console.error('Fetch profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
});

module.exports = router;

