const express = require('express');
const router = express.Router();
const db = require('../database');
const authMiddleware = require('../middleware/auth');

router.get('/', authMiddleware, (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM custom_strings WHERE createdBy = ? ORDER BY createdAt DESC');
    const strings = stmt.all(req.user.email);
    res.json({ success: true, strings });
  } catch (err) {
    console.error('Error fetching custom strings:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', authMiddleware, (req, res) => {
  const { title, string, process } = req.body;
  if (!title || !string || !process) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  try {
    const stmt = db.prepare('INSERT INTO custom_strings (title, string, process, createdBy) VALUES (?, ?, ?, ?)');
    const info = stmt.run(title, string, process, req.user.email);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Error adding custom string:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/import', authMiddleware, (req, res) => {
  const { strings, process } = req.body;
  if (!strings || !Array.isArray(strings) || !process) {
    return res.status(400).json({ success: false, message: 'Invalid data format' });
  }
  
  try {
    const insert = db.prepare('INSERT INTO custom_strings (title, string, process, createdBy) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((items) => {
      let count = 0;
      for (const item of items) {
        if (item.title && item.string) {
          insert.run(item.title, item.string, process, req.user.email);
          count++;
        }
      }
      return count;
    });
    
    const count = insertMany(strings);
    res.json({ success: true, count });
  } catch (err) {
    console.error('Error importing custom strings:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  try {
    const stmt = db.prepare('DELETE FROM custom_strings WHERE id = ? AND createdBy = ?');
    const info = stmt.run(id, req.user.email);
    if (info.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, message: 'String not found or not authorized' });
    }
  } catch (err) {
    console.error('Error deleting custom string:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
