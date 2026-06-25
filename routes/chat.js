const express = require('express');
const router = express.Router();
const db = require('../database');

const MAX_ATTACHMENT_CHARS = 12 * 1024 * 1024;

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
    // Auto-delete messages older than 2 days
    db.prepare("DELETE FROM chat_messages WHERE created_at < datetime('now', '-2 days')").run();

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

  const attachment = attachment_url ? String(attachment_url).trim() : null;
  if (attachment && attachment.length > MAX_ATTACHMENT_CHARS) {
    return res.status(413).json({ success: false, message: 'Attachment is too large' });
  }
  if (
    attachment &&
    !/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(attachment) &&
    !/^https?:\/\//i.test(attachment)
  ) {
    return res.status(400).json({ success: false, message: 'Invalid attachment format' });
  }
  
  // Basic validation to prevent XSS is done on frontend, but we should strip HTML tags here
  const safeMessage = message ? message.replace(/</g, "&lt;").replace(/>/g, "&gt;") : null;
  const safeAttachment = attachment ? attachment.replace(/</g, "&lt;").replace(/>/g, "&gt;") : null;

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
