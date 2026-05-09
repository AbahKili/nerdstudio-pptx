'use strict';

const fs = require('fs');
const path = require('path');
const { makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers } = require('baileys');
const QRCode = require('qrcode');
const { agentDir } = require('../config');

const AUTH_DIR = path.join(agentDir, 'auth_info_baileys');

let sock = null;
let pendingQR = null;
let qrImageBuffer = null;
let pairingCode = null;
let pairingPhone = null;
let isConnected = false;
let messageHandler = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000; // 60s max backoff

async function init({ onMessage, phoneNumber }) {
  messageHandler = onMessage;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: true,
    connectTimeoutMs: 30000,
    keepAliveIntervalMs: 15000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    process.stderr.write(`[nara-wa] connection.update: connection=${connection} qr=${!!qr} registered=${sock.authState.creds.registered}\n`);

    // QR code received — render it
    if (qr) {
      pendingQR = qr;
      try {
        qrImageBuffer = await QRCode.toBuffer(qr, { width: 400, margin: 2 });
      } catch { /* non-fatal */ }
      process.stderr.write('[nara-wa] QR code ready — visit /connect to scan\n');
    }

    if (connection === 'open') {
      pendingQR = null;
      qrImageBuffer = null;
      pairingCode = null;
      isConnected = true;
      reconnectAttempts = 0;
      process.stderr.write('[nara-wa] WhatsApp connected\n');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      process.stderr.write(`[nara-wa] connection closed (status=${statusCode}, reconnect=${shouldReconnect})\n`);

      if (shouldReconnect) {
        const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY);
        reconnectAttempts++;
        process.stderr.write(`[nara-wa] reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts})\n`);
        setTimeout(() => init({ onMessage: messageHandler, phoneNumber }), delay);
      } else {
        // Actually delete auth files on logout
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          process.stderr.write('[nara-wa] auth files deleted — fresh start on next restart\n');
        } catch (err) {
          process.stderr.write(`[nara-wa] failed to delete auth files: ${err.message}\n`);
        }
      }
    }
  });

  // Incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    if (!messageHandler) return;
    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      try {
        await messageHandler(msg);
      } catch (err) {
        process.stderr.write(`[nara-wa] message handler error: ${err.message}\n`);
      }
    }
  });

  return sock;
}

function getSocket() {
  return sock;
}

function getQR() {
  return { text: pendingQR, image: qrImageBuffer };
}

function getConnectInfo() {
  return {
    connected: isConnected,
    qrAvailable: !!pendingQR,
    qrText: pendingQR || null,
    pairingCode: pairingCode || null,
    pairingPhone: pairingPhone || null,
  };
}

async function requestPairingCode(phoneNumber) {
  if (!sock) throw new Error('Socket not initialized');
  if (sock.authState.creds.registered) return 'Already registered';
  return sock.requestPairingCode(phoneNumber);
}

async function sendMessage(to, text) {
  if (!sock) throw new Error('Socket not connected');
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

module.exports = { init, getSocket, getQR, getConnectInfo, requestPairingCode, sendMessage };
