// ~/design2slides/notify.js
const fetch = require('node-fetch');

async function notifyWA(message) {
  try {
    const res = await fetch('http://localhost:3232/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    const data = await res.json();
    return data.ok;
  } catch (err) {
    console.error('[notify] Failed to send WA:', err.message);
    return false;
  }
}

module.exports = { notifyWA };
