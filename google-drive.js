// ~/design2slides/google-drive.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const TOKEN_FILE = '/root/nerdy-fellow/google-token.json';
const CLIENT_ID = 'REDACTED';
const CLIENT_SECRET = 'REDACTED';

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) {
    return cachedToken.access_token;
  }

  const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
  const stored = JSON.parse(raw);

  // Try stored access token first
  if (stored.access_token && stored.expiry_date > Date.now()) {
    cachedToken = { access_token: stored.access_token, expires: stored.expiry_date };
    return stored.access_token;
  }

  // Refresh
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google auth refresh failed: ${err}`);
  }

  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expires: Date.now() + (data.expires_in * 1000) - 60000,
  };

  // Update stored token
  stored.access_token = data.access_token;
  stored.expiry_date = Date.now() + (data.expires_in * 1000);
  if (data.refresh_token) stored.refresh_token = data.refresh_token;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2));

  return data.access_token;
}

async function uploadAndConvert(pptxPath, designName, userToken) {
  const token = userToken || await getAccessToken();
  const pptxBuffer = fs.readFileSync(pptxPath);

  // Step 1: Upload with conversion
  const boundary = '---design2slides' + Date.now();
  const metadata = JSON.stringify({
    name: designName || 'Claude Design Presentation',
    mimeType: 'application/vnd.google-apps.presentation',
  });

  const body = Buffer.concat([
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(metadata),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n`),
    pptxBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Drive upload failed: ${err}`);
  }

  const file = await uploadRes.json();

  // Step 2: Set permissions - anyone with link can view
  await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  const slidesURL = `https://docs.google.com/presentation/d/${file.id}/edit`;

  return { slidesURL, fileId: file.id };
}

async function shareWithEmail(fileId, email) {
  const token = await getAccessToken();

  // Share as writer — the user gets full edit access
  const shareRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=true&emailMessage=Your+Google+Slides+from+Nerd+Studio.+Open+and+choose+File+%3E+Make+a+copy+to+own+it.`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
    }
  );

  if (!shareRes.ok) {
    const err = await shareRes.text();
    console.error(`[drive] Share with ${email} failed: ${err}`);
    return false;
  }

  console.log(`[drive] Shared ${fileId} with ${email} as writer — they can make a copy to own it`);
  return true;
}

module.exports = { uploadAndConvert, shareWithEmail, getAccessToken };
