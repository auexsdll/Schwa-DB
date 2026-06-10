require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3000;

// Mail Transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Middleware
app.use(express.json());

// CORS Configuration
app.use(cors());

// Temel güvenlik için electron-app-only mantığı eklenebilir, şimdilik basit CORS kullanıyoruz.

// Routes
const keysRouter = require('./routes/keys');
const scansRouter = require('./routes/scans');
const adminRouter = require('./routes/admin');

app.use('/api/key', keysRouter);
app.use('/api/scan', scansRouter);
app.use('/api/admin', adminRouter);

const db = require('./database'); // Add this at the top with other requires

// Public Registration Webhook Endpoint
app.post('/api/register', async (req, res) => {
  try {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
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

    if (!response.ok) {
      throw new Error(`Discord API responded with ${response.status}`);
    }

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

// Admin Respond Endpoint (Direct GET from Discord)
app.get('/api/respond', async (req, res) => {
  try {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
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
      generatedKey = 'SCHWA-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      db.prepare(`
        INSERT INTO keys (id, game, createdBy, createdAt, active, maxUses, currentUses) 
        VALUES (?, 'System', 'Admin', datetime('now'), 1, 1, 0)
      `).run(generatedKey);
    }

    // Send Email
    if (process.env.SMTP_USER) {
      try {
        await transporter.sendMail({
          from: `"Schwa Scanner" <${process.env.SMTP_USER}>`,
          to: application.email,
          subject: isApprove ? 'Your Schwa Scanner Application is Approved!' : 'Schwa Scanner Application Update',
          html: isApprove 
            ? `<div style="font-family: Arial, sans-serif; background: #0f0f13; color: white; padding: 20px;">
                <h2 style="color: #4ade80;">Welcome to Schwa Scanner!</h2>
                <p>Your application has been approved by our administrators.</p>
                <p>Your automatically generated License Key is:</p>
                <h3 style="background: #222; padding: 10px; border-radius: 5px; display: inline-block;">${generatedKey}</h3>
                <p>You can download the software from our website.</p>
               </div>` 
            : `<div style="font-family: Arial, sans-serif; background: #0f0f13; color: white; padding: 20px;">
                <h2 style="color: #f87171;">Application Update</h2>
                <p>Unfortunately, your application for Schwa Scanner was not approved at this time.</p>
               </div>`
        });
      } catch (err) {
        console.error("Email sending error:", err);
      }
    }

    // Send Webhook Reply
    if (webhookUrl) {
      const payload = {
        content: isApprove 
          ? `✅ **Approved by Administrator.**\n🔑 A unique license key (\`${generatedKey}\`) was automatically generated and emailed to **${application.email}**.` 
          : `❌ **Rejected by Administrator.**\nAn email notification has been sent to **${application.email}**.`
      };

      if (application.message_id) {
        payload.message_reference = { message_id: application.message_id };
      }

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    // Return HTML that auto-closes
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
  } catch (error) {
    console.error("Respond error:", error);
    res.status(500).send("An error occurred: " + error.message);
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.lang = 'tr';
  console.log(`Backend server ${port} portunda çalışıyor.`);
});
