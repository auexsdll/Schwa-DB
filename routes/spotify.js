const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const querystring = require('querystring');

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3000/api/spotify/callback';
// Update frontend URL depending on dev/prod
const frontendUrl = 'http://localhost:5173'; 

// Generate random string for state
const generateRandomString = (length) => {
  return crypto.randomBytes(60).toString('hex').slice(0, length);
};

router.get('/login', (req, res) => {
  const state = generateRandomString(16);
  const scope = 'user-read-private user-read-email user-modify-playback-state user-read-playback-state streaming user-read-currently-playing';

  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: clientId,
      scope: scope,
      redirect_uri: redirectUri,
      state: state
    }));
});

router.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  const state = req.query.state || null;

  if (state === null) {
    res.redirect(frontendUrl + '/?' + querystring.stringify({ error: 'state_mismatch' }));
    return;
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64'))
      },
      body: querystring.stringify({
        code: code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const data = await response.json();

    if (response.ok) {
      const access_token = data.access_token;
      const refresh_token = data.refresh_token;

      // Pass tokens back to frontend via query string
      res.redirect(frontendUrl + '/?' + querystring.stringify({
        spotify_access_token: access_token,
        spotify_refresh_token: refresh_token
      }));
    } else {
      res.redirect(frontendUrl + '/?' + querystring.stringify({ error: 'invalid_token' }));
    }
  } catch (error) {
    console.error('Spotify callback error:', error);
    res.redirect(frontendUrl + '/?' + querystring.stringify({ error: 'server_error' }));
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'No refresh token provided' });

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + (Buffer.from(clientId + ':' + clientSecret).toString('base64'))
      },
      body: querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      })
    });

    const data = await response.json();
    if (response.ok) {
      res.json({
        access_token: data.access_token,
        refresh_token: data.refresh_token || refresh_token // Sometimes Spotify doesn't return a new refresh token
      });
    } else {
      res.status(400).json({ error: 'Failed to refresh token' });
    }
  } catch (error) {
    console.error('Spotify refresh error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
