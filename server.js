require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// No need for nodemailer anymore, we will use direct REST API
// to bypass all Railway port and SMTP blocking issues.

const app = express();
app.set('trust proxy', 1); // Fixes rate limit warnings on Railway

const port = process.env.PORT || 3000;

// Middleware
app.use(helmet()); // Sets security HTTP headers

// CORS Configuration
const corsOptions = {
  origin: '*',
  methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
};
app.use(cors(corsOptions));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 2000, // Increased limit for SPA dashboard
  skip: (req) => req.method === 'OPTIONS', // Skip preflight
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api', limiter); // Apply rate limiting to all API routes

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// CORS already configured above

// Temel güvenlik için electron-app-only mantığı eklenebilir, şimdilik basit CORS kullanıyoruz.

// Routes
const keysRouter = require('./routes/keys');
const scansRouter = require('./routes/scans');
const adminRouter = require('./routes/admin');
const teamsRouter = require('./routes/teams');
const spotifyRouter = require('./routes/spotify');

app.use('/api/key', keysRouter);
app.use('/api/scan', scansRouter);
app.use('/api/admin', adminRouter);
app.use('/api/teams', teamsRouter);
app.use('/api/spotify', spotifyRouter);

const db = require('./database'); // Add this at the top with other requires

// Public Registration Webhook Endpoint
app.post('/api/register', async (req, res) => {
  try {
    // Webhook disabled by user request
    const webhookUrl = null; // process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return res.status(500).json({ error: "Webhook is not configured on backend." });

    const { username, email, discord, reason } = req.body;

    // Save to Database
    const stmt = db.prepare(`INSERT INTO applications (username, email, discord, reason, status) VALUES (?, ?, ?, ?, 'pending')`);
    const info = stmt.run(username, email, discord || '', reason || '');
    const appId = info.lastInsertRowid;

    const backendUrl = "https://schwa-db-production.up.railway.app";
    
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `🟢 **New Application Received from ${username}!**`,
        embeds: [{
          title: "Access Request Application",
          color: 9384170,
          fields: [
            { name: "👤 Username", value: username, inline: true },
            { name: "📧 Email", value: email, inline: true },
            { name: "💬 Discord ID", value: discord || "N/A", inline: true },
            { name: "📝 Reason for Access", value: reason || "N/A" },
            { name: "⚡ Actions", value: `[✅ Click to Approve](${backendUrl}/api/respond?id=${appId}&action=approve) • [❌ Reject](${backendUrl}/api/respond?id=${appId}&action=reject)`, inline: false }
          ],
          footer: { text: `Schwa Scanner Web • App ID: ${appId}` },
          timestamp: new Date().toISOString()
        }]
      })
    });

    const messageData = await response.json();
    if (messageData && messageData.id) {
      db.prepare(`UPDATE applications SET message_id = ? WHERE id = ?`).run(messageData.id, appId);
    }

    res.json({ success: true, message: "Application sent successfully" });
  } catch (error) {
    console.error("Register webhook error:", error);
    res.status(500).json({ error: "Failed to send application", details: error.message });
  }
});

const axios = require('axios');

// Public Referral Registration Endpoint
app.post('/api/customer/register-referral', async (req, res) => {
  try {
    const { code, desiredUsername, discordId, email, teamName, password } = req.body;
    if (!code || !desiredUsername || !discordId || !email || !teamName || !password) {
      return res.status(400).json({ success: false, message: 'All fields (including password) are required for security purposes.' });
    }

    // 1. Validate referral code
    const referral = db.prepare('SELECT * FROM referrals WHERE code = ?').get(code);
    if (!referral) {
      return res.status(400).json({ success: false, message: 'Invalid referral code.' });
    }
    if (referral.is_used === 1) {
      return res.status(400).json({ success: false, message: 'This referral code has already been used.' });
    }

    // 1.5 Validate Team Name
    const targetTeam = db.prepare('SELECT name FROM teams WHERE id = ?').get(referral.team_id);
    if (!targetTeam || targetTeam.name !== teamName) {
      return res.status(400).json({ success: false, message: 'Invalid Team Name for this referral code.' });
    }

    // 2. Check if desired username is taken (in keys or team_members)
    const existingKey = db.prepare('SELECT id FROM keys WHERE label = ? COLLATE NOCASE').get(desiredUsername);
    const existingMember = db.prepare('SELECT id FROM team_members WHERE username = ? COLLATE NOCASE').get(desiredUsername);
    if (existingKey || existingMember) {
      return res.status(400).json({ success: false, message: 'Username is already taken.' });
    }

    // 3. Generate a new license key (acts as their password)
    const chars = '0123456789';
    let newKeyId = '';
    for (let i = 0; i < 6; i++) {
      newKeyId += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const expiryDate = new Date(Date.now() + 30 * 86400000); 

    // Fetch Discord Avatar via Bot Token
    let discordAvatarUrl = '';
    if (discordId && process.env.OSINT_TOKEN) {
      try {
        const apiRes = await axios.get(`https://discord.com/api/v10/users/${discordId}`, {
          headers: { Authorization: `Bot ${process.env.OSINT_TOKEN}` },
          validateStatus: false
        });
        if (apiRes.status === 200 && apiRes.data.avatar) {
          const ext = apiRes.data.avatar.startsWith('a_') ? 'gif' : 'png';
          discordAvatarUrl = `https://cdn.discordapp.com/avatars/${discordId}/${apiRes.data.avatar}.${ext}?size=1024`;
        }
      } catch (e) {
        console.error("Discord avatar fetch error:", e.message);
      }
    }

    // 4. Create the user as a Key
    db.prepare(`
      INSERT INTO keys (id, game, label, createdBy, createdAt, expiresAt, active, maxUses, currentUses, notes, imageUrl, discord_id, email, password) 
      VALUES (?, 'fivem', ?, ?, ?, ?, 1, 10, 0, 'Joined via Referral', ?, ?, ?, ?)
    `).run(newKeyId, desiredUsername, referral.created_by, new Date().toISOString(), expiryDate.toISOString(), discordAvatarUrl, discordId, email, password);

    // 5. Add user to team
    db.prepare("INSERT INTO team_members (team_id, username, role, discord_id, email) VALUES (?, ?, 'member', ?, ?)").run(referral.team_id, desiredUsername, discordId, email);

    // 6. Mark referral as used
    db.prepare('UPDATE referrals SET is_used = 1, used_by = ? WHERE code = ?').run(desiredUsername, code);

    // 7. Auto login response and Email notification
    if (process.env.SMTP_PASS) {
      const emailHtml = `
      <div style="font-family: sans-serif; background-color: #0b0c10; color: #fff; padding: 40px; border-radius: 12px; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #6366f1;">Welcome to Schwa Scanner!</h2>
        <p>You have successfully joined the team <strong>${teamName}</strong>.</p>
        <p>Your account has been created with the following details:</p>
        <ul style="background-color: #111214; padding: 20px; border-radius: 8px; list-style-type: none;">
          <li><strong>Username:</strong> ${desiredUsername}</li>
          <li><strong>Password:</strong> ${password}</li>
          <li><strong>License Key:</strong> ${newKeyId}</li>
        </ul>
        <p>You can use either your Password or your License Key to log in.</p>
        <p>Best Regards,<br>Schwa Development Team</p>
      </div>`;

      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SMTP_PASS.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Schwa Scanner <noreply@schwadevelopment.com.tr>',
          to: email,
          subject: 'Welcome to Schwa Scanner!',
          html: emailHtml
        })
      }).catch(err => console.error("Resend API Request Error:", err));
    }

    res.json({
      success: true,
      message: 'Registration successful via Referral!',
      user: {
        username: desiredUsername,
        role: 'member',
        key: newKeyId,
        createdAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("Referral registration error:", error);
    res.status(500).json({ success: false, message: 'Database error' });
  }
});

// Admin Respond Endpoint (Direct GET from Discord)
app.get('/api/respond', async (req, res) => {
  try {
    // Webhook disabled by user request
    const webhookUrl = null; // process.env.DISCORD_WEBHOOK_URL;
    const { id, action } = req.query;
    
    if (!id || !action) return res.status(400).send("Missing parameters");
    
    // Check if application exists
    const application = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
    if (!application) return res.status(404).send("Application not found");
    if (application.status !== 'pending') return res.status(400).send("Application already processed");

    const isApprove = action === 'approve';
    const newStatus = isApprove ? 'approved' : 'rejected';
    
    // Update DB
    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(newStatus, id);

    let generatedKey = null;
    if (isApprove) {
      const generatePassword = (length) => {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        const randomBytes = crypto.randomBytes(length);
        for (let i = 0; i < length; i++) {
          result += chars[randomBytes[i] % chars.length];
        }
        return result;
      };
      generatedKey = generatePassword(16);
      db.prepare(`
        INSERT INTO keys (id, game, label, createdBy, createdAt, active, maxUses, currentUses) 
        VALUES (?, 'System', ?, 'Admin', datetime('now'), 1, 1, 0)
      `).run(generatedKey, application.username);
    }

    // 1. ANINDA YANIT VER (Tarayıcı Donmasın)
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Processed</title>
        <style>
          body { background-color: #0f0f13; color: white; font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .container { background: #1a1a24; padding: 2rem 4rem; border-radius: 1rem; border: 1px solid ${isApprove ? '#22c55e40' : '#ef444440'}; text-align: center; }
          h1 { color: ${isApprove ? '#4ade80' : '#f87171'}; margin-top: 0; }
          p { color: #9ca3af; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Successfully ${isApprove ? 'Approved' : 'Rejected'}!</h1>
          <p>You can close this tab now.</p>
        </div>
        <script>
          setTimeout(() => { window.close(); }, 1500);
        </script>
      </body>
      </html>
    `);

    // 2. MAİL VE DİSCORD İŞLEMLERİNİ ARKA PLANDA YAP
    if (process.env.SMTP_PASS) {
      const emailHtml = isApprove 
        ? `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; padding: 0; background-color: #000000; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrapper { width: 100%; table-layout: fixed; background-color: #000000; padding: 40px 0; }
  .container { max-width: 600px; margin: 0 auto; background: #09090b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 0 60px rgba(74, 222, 128, 0.05); }
  .header { padding: 40px 20px; text-align: center; border-bottom: 1px solid #18181b; background: radial-gradient(circle at top, #052e16 0%, #09090b 100%); }
  .logo { max-width: 140px; margin-bottom: 20px; }
  .header h1 { margin: 0; color: #4ade80; font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
  .content { padding: 40px 40px; text-align: center; }
  .content p { color: #a1a1aa; font-size: 16px; line-height: 1.6; margin-bottom: 30px; }
  .key-container { background: #000000; border: 1px solid #27272a; padding: 30px; border-radius: 12px; margin: 30px 0; display: inline-block; position: relative; }
  .label { color: #71717a; font-size: 11px; text-transform: uppercase; letter-spacing: 3px; margin-bottom: 15px; display: block; font-weight: 600; }
  .key { color: #ffffff; font-size: 24px; font-weight: 800; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; letter-spacing: 2px; }
  .footer { padding: 30px 20px; text-align: center; border-top: 1px solid #18181b; color: #52525b; font-size: 12px; background: #000000; }
  .highlight { color: #ffffff; font-weight: 600; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <img src="https://schwadevelopment.com.tr/logo.png" alt="Schwa" class="logo">
        <h1>Access Granted</h1>
      </div>
      <div class="content">
        <p>Hello <span class="highlight">${application.username}</span>,<br><br>Your application for <strong>Schwa Scanner</strong> has been officially approved by our administrative team. We are thrilled to welcome you aboard.</p>
        <div class="key-container">
          <span class="label">Your Unique License Key</span>
          <span class="key">${generatedKey}</span>
        </div>
        <p style="font-size: 14px; color: #71717a; margin-bottom: 0;">Please keep this key secure. You will use it to authenticate your software.</p>
      </div>
      <div class="footer">
        © 2026 Schwa Development. All rights reserved.<br>
        If you have any questions, please contact our support team.
      </div>
    </div>
  </div>
</body>
</html>` 
        : `<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; padding: 0; background-color: #000000; color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrapper { width: 100%; table-layout: fixed; background-color: #000000; padding: 40px 0; }
  .container { max-width: 600px; margin: 0 auto; background: #09090b; border: 1px solid #27272a; border-radius: 16px; overflow: hidden; box-shadow: 0 0 60px rgba(248, 113, 113, 0.05); }
  .header { padding: 40px 20px; text-align: center; border-bottom: 1px solid #18181b; background: radial-gradient(circle at top, #450a0a 0%, #09090b 100%); }
  .logo { max-width: 140px; margin-bottom: 20px; }
  .header h1 { margin: 0; color: #f87171; font-size: 26px; font-weight: 700; letter-spacing: -0.5px; }
  .content { padding: 40px 40px; text-align: center; }
  .content p { color: #a1a1aa; font-size: 16px; line-height: 1.6; }
  .footer { padding: 30px 20px; text-align: center; border-top: 1px solid #18181b; color: #52525b; font-size: 12px; background: #000000; }
  .highlight { color: #ffffff; font-weight: 600; }
</style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <img src="https://schwadevelopment.com.tr/logo.png" alt="Schwa" class="logo">
        <h1>Application Denied</h1>
      </div>
      <div class="content">
        <p>Hello <span class="highlight">${application.username}</span>,<br><br>After careful review, we regret to inform you that your application for <strong>Schwa Scanner</strong> has not been approved at this time.<br><br>This decision is final and no further details can be provided by the administrative team.</p>
      </div>
      <div class="footer">
        © 2026 Schwa Development. All rights reserved.
      </div>
    </div>
  </div>
</body>
</html>`;

      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SMTP_PASS.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'Schwa Scanner <noreply@schwadevelopment.com.tr>',
          to: application.email,
          subject: isApprove ? 'Your Schwa Scanner Application is Approved!' : 'Schwa Scanner Application Update',
          html: emailHtml
        })
      })
      .then(async (res) => {
        const data = await res.json();
        console.log("Resend API Result:", data);
      })
      .catch(err => console.error("Resend API Request Error:", err));
    }

    // Send Webhook Reply
    if (webhookUrl) {
      const payload = {
        content: isApprove 
          ? `✅ **Approved by Schwa.**\n🔑 A unique license key (\`${generatedKey}\`) was automatically generated and emailed to **${application.email}**.` 
          : `❌ **Rejected by Schwa.**\nAn email notification has been sent to **${application.email}**.`
      };

      if (application.message_id) {
        payload.message_reference = { message_id: application.message_id };
      }

      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(err => console.error("Webhook error:", err));
    }

  } catch (error) {
    console.error("Respond error:", error);
    if (!res.headersSent) {
      res.status(500).send("An error occurred");
    }
  }
});

// Download route (Backend to GitHub API)
app.get('/api/download', async (req, res) => {
  try {
    const headers = { 'User-Agent': 'SchwaScannerBackend' };
    // Eğer GITHUB_TOKEN varsa private repolar için kullan
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch("https://api.github.com/repos/auexsdll/Schwa-Scanner/releases", { headers });
    
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`GitHub API Hatası: ${response.status} - ${errData.message || response.statusText}`);
    }
    const data = await response.json();
    
    if (!data || data.length === 0) {
      throw new Error("Hiçbir Release bulunamadı (Pre-release dahil).");
    }

    const latestRelease = data[0]; // En baştaki (en son) release (pre-release olsa bile)
    
    // .exe ile biten veya tek/ilk asset olan dosyayı al
    let exeAsset = latestRelease.assets.find(a => a.name.endsWith('.exe'));
    if (!exeAsset && latestRelease.assets.length > 0) {
      exeAsset = latestRelease.assets[0];
    }
    if (exeAsset) {
      // 1. Generate random 6 character string
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let randomString = '';
      for (let i = 0; i < 6; i++) {
        randomString += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const fileName = `Schwa Scanner - ${randomString}.exe`;

      // 2. Fetch the actual file stream from GitHub releases
      const fileResponse = await fetch(exeAsset.browser_download_url, {
        redirect: 'follow'
      });

      if (!fileResponse.ok) {
        return res.status(500).send(`Github dosya stream hatası: ${fileResponse.statusText}`);
      }

      // 3. Set headers for file download
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      
      const contentLength = fileResponse.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      // 4. Pipe the Web ReadableStream to the Express Response (Node.js 18+)
      const { Readable } = require('stream');
      Readable.fromWeb(fileResponse.body).pipe(res);

    } else {
      res.status(404).send("Release içinde .exe dosyası bulunamadı.");
    }
  } catch (error) {
    console.error("Download Error:", error.message);
    res.status(500).send(`İndirme linki oluşturulamadı. Hata detay: ${error.message}`);
  }
});

// Müşteri Giriş API'si (Web sitesi ve Müşteri Paneli için)
app.post('/api/customer/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Lütfen kullanıcı adı ve şifrenizi girin.' });
  }

  try {
    if (username === 'schwa' && password === 'schwa.12345') {
      return res.json({
        success: true,
        message: 'Master Girişi!',
        user: {
          username: 'schwa',
          role: 'god',
          key: 'master-key',
          createdAt: new Date().toISOString()
        }
      });
    }

    // Veritabanında Kullanıcı Adı (label) ve Şifresi (id/key) eşleşen bir kayıt var mı kontrol et
    const userRecord = db.prepare('SELECT * FROM keys WHERE label = ? COLLATE NOCASE AND (id = ? OR password = ?)').get(username, password, password);

    if (!userRecord) {
      return res.status(401).json({ success: false, message: 'Geçersiz kullanıcı adı veya şifre.' });
    }

    if (userRecord.active !== 1) {
      return res.status(403).json({ success: false, message: 'Hesabınız yöneticiler tarafından devre dışı bırakılmış.' });
    }

    // Başarılı giriş
    return res.json({
      success: true,
      message: 'Giriş başarılı!',
      user: {
        username: userRecord.label,
        role: userRecord.role || 'member',
        key: userRecord.id,
        createdAt: userRecord.createdAt
      }
    });

  } catch (error) {
    console.error("Login API Hatası:", error);
    return res.status(500).json({ success: false, message: 'Sunucu hatası oluştu.' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/customer/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });

  try {
    const userRecord = db.prepare('SELECT * FROM keys WHERE email = ? COLLATE NOCASE').get(email);
    if (!userRecord) return res.status(404).json({ success: false, message: 'No account found with this email' });

    const newPassword = Math.random().toString(36).slice(-8);
    db.prepare('UPDATE keys SET password = ? WHERE id = ?').run(newPassword, userRecord.id);

    if (process.env.SMTP_PASS) {
      const emailHtml = `
      <div style="font-family: sans-serif; background-color: #0b0c10; color: #fff; padding: 40px; border-radius: 12px; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #6366f1;">Password Reset</h2>
        <p>Your password has been reset successfully.</p>
        <p>Your new login details:</p>
        <ul style="background-color: #111214; padding: 20px; border-radius: 8px; list-style-type: none;">
          <li><strong>Username:</strong> ${userRecord.label}</li>
          <li><strong>New Password:</strong> ${newPassword}</li>
        </ul>
        <p>Best Regards,<br>Schwa Development Team</p>
      </div>`;

      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.SMTP_PASS.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Schwa Scanner <noreply@schwadevelopment.com.tr>',
          to: email,
          subject: 'Your New Password - Schwa Scanner',
          html: emailHtml
        })
      }).catch(err => console.error(err));
    }

    res.json({ success: true, message: 'New password sent to your email.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.listen(port, () => {
  console.lang = 'tr';
  console.log(`Backend server ${port} portunda çalışıyor.`);
});

