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

module.exports = router;
