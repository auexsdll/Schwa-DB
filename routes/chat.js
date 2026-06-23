const express = require('express');
const router = express.Router();
const db = require('../database');

// Middleware to check authentication (we use user_id from headers/body in simple setups, but let's assume it's passed)
const authenticate = (req, res, next) => {
  const userId = req.headers['authorization'] || req.headers['x-user-id'] || req.body.user_id || req.query.user_id;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  
  // Verify user exists by their username (label)
  const stmt = db.prepare("SELECT * FROM keys WHERE label = ? COLLATE NOCASE");
  const user = stmt.get(userId);
  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid user' });
  }
  
  req.user = user;
  next();
};

// Get last 50 chat messages
router.get('/messages', authenticate, (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT c.*, k.label as username, k.discord_id, k.email, k.avatar_url, k.profile_color, tm.team_id, t.name as team_name, t.logo_url as team_logo
      FROM chat_messages c
      JOIN keys k ON c.user_id = k.id
      LEFT JOIN team_members tm ON k.label = tm.username COLLATE NOCASE
      LEFT JOIN teams t ON tm.team_id = t.id
      ORDER BY c.created_at DESC
      LIMIT 50
    `);
    
    const messages = stmt.all().reverse(); // Reverse to get chronological order
    
    res.json({ success: true, messages });
  } catch (error) {
    console.error('Fetch chat error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch messages' });
  }
});

// Post a new chat message
router.post('/messages', authenticate, (req, res) => {
  const { message, attachment_url } = req.body;
  
  if (!message && !attachment_url) {
    return res.status(400).json({ success: false, message: 'Message or attachment is required' });
  }
  
  // Basic validation to prevent XSS is done on frontend, but we should strip HTML tags here
  const safeMessage = message ? message.replace(/</g, "&lt;").replace(/>/g, "&gt;") : null;
  const safeAttachment = attachment_url ? attachment_url.replace(/</g, "&lt;").replace(/>/g, "&gt;") : null;

  try {
    const stmt = db.prepare(`
      INSERT INTO chat_messages (user_id, message, attachment_url)
      VALUES (?, ?, ?)
    `);
    
    const info = stmt.run(req.user.id, safeMessage, safeAttachment);
    
    res.json({ success: true, message_id: info.lastInsertRowid });
  } catch (error) {
    console.error('Post chat error:', error);
    res.status(500).json({ success: false, message: 'Failed to post message' });
  }
});

module.exports = router;
