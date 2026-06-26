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

function scanHasThreat(resultsJson) {
  try {
    const parsed = JSON.parse(resultsJson || '[]');
    const findings = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.findings) ? parsed.findings : [parsed]);
    return findings.some(finding => {
      const severity = String(finding.severity || finding.seviye || '').toLowerCase();
      return ['critical', 'high'].includes(severity);
    });
  } catch (e) {
    return false;
  }
}

function getSeasonById(seasonId) {
  if (!seasonId || seasonId === 'all') return null;
  if (seasonId === 'active') {
    return db.prepare('SELECT * FROM team_seasons WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  }
  return db.prepare('SELECT * FROM team_seasons WHERE id = ?').get(seasonId);
}

function getSeasonWhere(prefix, season) {
  if (!season) return { clause: '', params: [] };
  const start = season.starts_at;
  const end = season.ends_at;
  if (end) {
    return { clause: ` AND ${prefix} >= ? AND ${prefix} <= ?`, params: [start, end] };
  }
  return { clause: ` AND ${prefix} >= ?`, params: [start] };
}

function getTeamStats(team, season = null) {
  const members = db.prepare('SELECT username FROM team_members WHERE team_id = ?').all(team.id);
  const memberUsernames = members.map(member => member.username);
  if (!memberUsernames.some(name => String(name).toLowerCase() === String(team.leader_username).toLowerCase())) {
    memberUsernames.push(team.leader_username);
  }

  let totalKeys = 0;
  let totalScans = 0;
  let totalCaught = 0;

  if (memberUsernames.length > 0) {
    const placeholders = memberUsernames.map(() => '?').join(',');
    const keyDate = getSeasonWhere('createdAt', season);
    const seasonalKeys = db.prepare(`SELECT id FROM keys WHERE (createdBy IN (${placeholders}) OR label IN (${placeholders}))${keyDate.clause}`).all(...memberUsernames, ...memberUsernames, ...keyDate.params);
    const allKeys = db.prepare(`SELECT id FROM keys WHERE createdBy IN (${placeholders}) OR label IN (${placeholders})`).all(...memberUsernames, ...memberUsernames);
    totalKeys = seasonalKeys.length;

    if (allKeys.length > 0) {
      const keyIds = allKeys.map(key => key.id);
      const scanPlaceholders = keyIds.map(() => '?').join(',');
      const scanDate = getSeasonWhere('scanned_at', season);
      const scans = db.prepare(`SELECT results_json FROM scans WHERE id IN (${scanPlaceholders})${scanDate.clause}`).all(...keyIds, ...scanDate.params);
      totalScans = scans.length;
      totalCaught = scans.filter(scan => scanHasThreat(scan.results_json)).length;
    }
  }

  return {
    membersCount: members.length,
    totalKeys,
    totalScans,
    totalCaught,
    score: totalCaught * 10 + totalScans * 2 + totalKeys
  };
}

// GET /api/teams/seasons
router.get('/seasons', (req, res) => {
  try {
    const seasons = db.prepare('SELECT * FROM team_seasons ORDER BY starts_at DESC').all();
    const activeSeason = seasons.find(season => season.active === 1) || null;
    res.json({ success: true, seasons, activeSeason });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/teams/seasons
router.post('/seasons', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can create seasons' });
    }
    const { name, starts_at, ends_at, activate } = req.body;
    if (!name) return res.status(400).json({ error: 'Season name required' });

    if (activate) db.prepare('UPDATE team_seasons SET active = 0').run();
    const info = db.prepare('INSERT INTO team_seasons (name, starts_at, ends_at, active, created_by) VALUES (?, ?, ?, ?, ?)').run(
      name,
      starts_at || new Date().toISOString(),
      ends_at || null,
      activate ? 1 : 0,
      req.headers['x-username'] || 'Unknown'
    );
    const season = db.prepare('SELECT * FROM team_seasons WHERE id = ?').get(info.lastInsertRowid);
    res.json({ success: true, season });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PUT /api/teams/seasons/:id/activate
router.put('/seasons/:id/activate', (req, res) => {
  try {
    const role = req.headers['x-role'];
    if (role !== 'god' && role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can activate seasons' });
    }
    const season = db.prepare('SELECT * FROM team_seasons WHERE id = ?').get(req.params.id);
    if (!season) return res.status(404).json({ error: 'Season not found' });
    db.prepare('UPDATE team_seasons SET active = 0').run();
    db.prepare('UPDATE team_seasons SET active = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/teams/leaderboard
router.get('/leaderboard', (req, res) => {
  try {
    const season = getSeasonById(req.query.seasonId || 'active');
    const teams = db.prepare('SELECT * FROM teams ORDER BY created_at ASC').all();
    const leaderboard = teams
      .map(team => ({
        ...team,
        stats: getTeamStats(team, season)
      }))
      .sort((a, b) => b.stats.score - a.stats.score || b.stats.totalCaught - a.stats.totalCaught || b.stats.totalScans - a.stats.totalScans)
      .map((team, index) => ({
        rank: index + 1,
        id: team.id,
        name: team.name,
        leader_username: team.leader_username,
        logo_url: team.logo_url,
        color: team.color,
        description: team.description,
        stats: team.stats
      }));

    res.json({ success: true, teams: leaderboard, season });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/teams/my-team
router.get('/my-team', (req, res) => {
  try {
    const username = req.headers['x-username'];
    const role = req.headers['x-role'];

    if (!username) return res.status(400).json({ error: 'Username required' });

    // First check if user is a member of any team
    const membership = db.prepare('SELECT * FROM team_members WHERE username = ? COLLATE NOCASE').get(username);
    
    // Check if user is a leader
    let team = db.prepare('SELECT * FROM teams WHERE leader_username = ? COLLATE NOCASE').get(username);

    if (!team && membership) {
      team = db.prepare('SELECT * FROM teams WHERE id = ?').get(membership.team_id);
    }

    if (!team) {
      return res.json({ team: null }); // User is not in any team
    }

    // Get members
    const members = db.prepare(`
      SELECT tm.username, tm.role, tm.joined_at, k.discord_id, k.imageUrl 
      FROM team_members tm 
      LEFT JOIN keys k ON tm.username = k.label COLLATE NOCASE 
      WHERE tm.team_id = ? 
      ORDER BY tm.joined_at ASC
    `).all(team.id);

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
        const scans = db.prepare(`SELECT results_json FROM scans WHERE id IN (${scanPlaceholders})`).all(...keyIds);
        totalScans = scans.length;
        
        scans.forEach(s => {
          let hasCritical = false;
          try {
             const resJson = JSON.parse(s.results_json);
             resJson.forEach(f => {
               if (f.seviye === 'Critical' || f.seviye === 'High') {
                 hasCritical = true;
               }
             });
             if (hasCritical) totalCaught++;
          } catch(e) {}
        });
      }
    }

    // Get active referrals
    const referrals = db.prepare('SELECT code, created_at, is_used, used_by FROM referrals WHERE team_id = ? ORDER BY created_at DESC').all(team.id);

    // Get custom roles
    const custom_roles = db.prepare('SELECT id, role_name, role_color FROM team_custom_roles WHERE team_id = ? ORDER BY created_at ASC').all(team.id);

    res.json({
      team,
      members,
      referrals,
      custom_roles,
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
    const existing = db.prepare('SELECT id FROM teams WHERE leader_username = ? COLLATE NOCASE').get(username);
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
    const { teamId, amount } = req.body;
    const username = req.headers['x-username'];
    
    let count = parseInt(amount) || 1;
    if (count > 50) count = 50; // max 50 at once
    if (count < 1) count = 1;

    const codes = [];
    const stmt = db.prepare('INSERT INTO referrals (code, team_id, created_by) VALUES (?, ?, ?)');
    
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        stmt.run(code, teamId, username);
        codes.push(code);
      }
    })();
    
    res.json({ success: true, codes });
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
    db.prepare('DELETE FROM team_members WHERE team_id = ? AND username = ? COLLATE NOCASE').run(teamId, targetUsername);
    
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

// Update team settings (Leader only)
router.post('/settings', (req, res) => {
  const { logo_url, description, color } = req.body;
  const username = req.headers['x-username']; // User must be the leader

  try {
    const team = db.prepare('SELECT * FROM teams WHERE leader_username = ?').get(username);
    if (!team) {
      return res.status(403).json({ success: false, message: 'You are not the leader of any team.' });
    }

    const stmt = db.prepare(`
      UPDATE teams 
      SET logo_url = COALESCE(?, logo_url),
          description = COALESCE(?, description),
          color = COALESCE(?, color)
      WHERE id = ?
    `);
    
    stmt.run(logo_url, description, color, team.id);
    res.json({ success: true, message: 'Team settings updated' });
  } catch (error) {
    console.error('Update team settings error:', error);
    res.status(500).json({ success: false, message: 'Failed to update team settings' });
  }
});

// Delete/Disband team (Leader only)
router.delete('/disband', (req, res) => {
  const username = req.headers['x-username'];

  try {
    const team = db.prepare('SELECT * FROM teams WHERE leader_username = ?').get(username);
    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found or unauthorized' });
    }

    db.prepare('DELETE FROM team_custom_roles WHERE team_id = ?').run(team.id);
    db.prepare('DELETE FROM team_members WHERE team_id = ?').run(team.id);
    db.prepare('DELETE FROM referrals WHERE team_id = ?').run(team.id);
    db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);

    res.json({ success: true, message: 'Team disbanded successfully' });
  } catch (error) {
    console.error('Disband team error:', error);
    res.status(500).json({ success: false, message: 'Failed to disband team' });
  }
});

// Add custom role
router.post('/roles', (req, res) => {
  const { role_name, role_color } = req.body;
  const username = req.headers['x-username'];
  try {
    const team = db.prepare('SELECT * FROM teams WHERE leader_username = ?').get(username);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found or unauthorized' });
    
    const count = db.prepare('SELECT COUNT(*) as count FROM team_custom_roles WHERE team_id = ?').get(team.id).count;
    if (count >= 2) return res.status(400).json({ success: false, message: 'Maximum 2 custom roles allowed' });

    db.prepare('INSERT INTO team_custom_roles (team_id, role_name, role_color) VALUES (?, ?, ?)').run(team.id, role_name, role_color);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Delete custom role
router.delete('/roles/:id', (req, res) => {
  const roleId = req.params.id;
  const username = req.headers['x-username'];
  try {
    const team = db.prepare('SELECT * FROM teams WHERE leader_username = ?').get(username);
    if (!team) return res.status(404).json({ success: false, message: 'Unauthorized' });
    
    // reset members with this role
    const role = db.prepare('SELECT role_name FROM team_custom_roles WHERE id = ? AND team_id = ?').get(roleId, team.id);
    if (role) {
      db.prepare('UPDATE team_members SET custom_role = NULL WHERE team_id = ? AND custom_role = ?').run(team.id, role.role_name);
      db.prepare('DELETE FROM team_custom_roles WHERE id = ? AND team_id = ?').run(roleId, team.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Assign role to member
router.post('/members/role', (req, res) => {
  const { target_username, role_type, role_name } = req.body; // role_type: 'admin', 'member', 'custom'
  const username = req.headers['x-username'];
  try {
    const team = db.prepare('SELECT * FROM teams WHERE leader_username = ?').get(username);
    if (!team) return res.status(404).json({ success: false, message: 'Unauthorized' });
    
    if (role_type === 'custom') {
      db.prepare('UPDATE team_members SET custom_role = ? WHERE team_id = ? AND username = ?').run(role_name, team.id, target_username);
    } else {
      db.prepare('UPDATE team_members SET role = ?, custom_role = NULL WHERE team_id = ? AND username = ?').run(role_type, team.id, target_username);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
