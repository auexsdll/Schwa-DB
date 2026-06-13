const express = require('express');
const router = express.Router();
const db = require('../database');
const crypto = require('crypto');

// Basit admin auth middleware (same as admin.js)
const adminAuth = (req, res, next) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
};

router.use(adminAuth);

// GET /api/teams/my-team
router.get('/my-team', (req, res) => {
  try {
    const username = req.headers['x-username'];
    const role = req.headers['x-role'];

    if (!username) return res.status(400).json({ error: 'Username required' });

    // First check if user is a member of any team
    const membership = db.prepare('SELECT * FROM team_members WHERE username = ?').get(username);
    
    // Check if user is a leader
    let team = db.prepare('SELECT * FROM teams WHERE leader_username = ?').get(username);

    if (!team && membership) {
      team = db.prepare('SELECT * FROM teams WHERE id = ?').get(membership.team_id);
    }

    if (!team) {
      return res.json({ team: null }); // User is not in any team
    }

    // Get members
    const members = db.prepare('SELECT username, role, joined_at FROM team_members WHERE team_id = ? ORDER BY joined_at ASC').all(team.id);

    // Get stats (Keys created by members, Scans by those keys, etc.)
    const memberUsernames = members.map(m => m.username);
    if (!memberUsernames.includes(team.leader_username)) {
      memberUsernames.push(team.leader_username); // Include leader
    }

    let totalKeys = 0;
    let totalScans = 0;
    let totalCaught = 0;
    
    if (memberUsernames.length > 0) {
      const placeholders = memberUsernames.map(() => '?').join(',');
      
      // Keys generated
      const keys = db.prepare(`SELECT id FROM keys WHERE createdBy IN (${placeholders})`).all(...memberUsernames);
      totalKeys = keys.length;

      if (keys.length > 0) {
        const keyIds = keys.map(k => k.id);
        const scanPlaceholders = keyIds.map(() => '?').join(',');
        const scans = db.prepare(`SELECT results_json, verdict FROM scans WHERE id IN (${scanPlaceholders})`).all(...keyIds);
        totalScans = scans.length;
        
        scans.forEach(s => {
          if (s.verdict === 'Critical' || s.verdict === 'High Risk') totalCaught++;
          try {
             const resJson = JSON.parse(s.results_json);
             resJson.forEach(f => {
               if (f.seviye === 'Critical' || f.seviye === 'High') {
                 // We could count individual findings, but let's stick to overall scan verdict
               }
             });
          } catch(e) {}
        });
      }
    }

    // Get active referrals
    const referrals = db.prepare('SELECT code, created_at, is_used, used_by FROM referrals WHERE team_id = ? ORDER BY created_at DESC').all(team.id);

    res.json({
      team,
      members,
      referrals,
      stats: {
        totalKeys,
        totalScans,
        totalCaught
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/teams/create
router.post('/create', (req, res) => {
  try {
    const { name } = req.body;
    const username = req.headers['x-username'];
    
    if (!name) return res.status(400).json({ error: 'Team name required' });

    // Check if user already has a team
    const existing = db.prepare('SELECT id FROM teams WHERE leader_username = ?').get(username);
    if (existing) return res.status(400).json({ error: 'You are already a team leader' });

    const info = db.prepare('INSERT INTO teams (name, leader_username) VALUES (?, ?)').run(name, username);
    const teamId = info.lastInsertRowid;
    
    // Add leader as member too
    db.prepare("INSERT INTO team_members (team_id, username, role) VALUES (?, ?, 'leader')").run(teamId, username);

    res.json({ success: true, teamId });
  } catch (err) {
    console.error(err);
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(400).json({ error: 'Team name already exists' });
    } else {
      res.status(500).json({ error: 'Database error' });
    }
  }
});

// POST /api/teams/referral
router.post('/referral', (req, res) => {
  try {
    const { teamId } = req.body;
    const username = req.headers['x-username'];
    
    // Generate a secure 8-character code
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();

    db.prepare('INSERT INTO referrals (code, team_id, created_by) VALUES (?, ?, ?)').run(code, teamId, username);
    
    res.json({ success: true, code });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/teams/member
router.delete('/member', (req, res) => {
  try {
    const { teamId, targetUsername, banAccount } = req.body;
    const username = req.headers['x-username'];
    
    // Verify current user is leader
    const team = db.prepare('SELECT leader_username FROM teams WHERE id = ?').get(teamId);
    if (!team || team.leader_username !== username) {
      return res.status(403).json({ error: 'Only team leader can remove members' });
    }

    // Delete from team_members
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND username = ?').run(teamId, targetUsername);
    
    // Ban account if requested
    if (banAccount) {
      db.prepare('UPDATE keys SET active = 0 WHERE label = ?').run(targetUsername);
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
