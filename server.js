require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

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
