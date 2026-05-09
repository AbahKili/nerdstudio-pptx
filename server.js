'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fetch = require('node-fetch');

const { htmlToPptx } = require('./convert');
const { uploadAndConvert, shareWithEmail } = require('./google-drive');
const { notifyWA } = require('./notify');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const TEMP_DIR = path.join(__dirname, 'temp');
const LEMON_SQUEEZY_SECRET = process.env.LEMON_SQUEEZY_SECRET || '';

// In-memory job tracking
const sseClients = new Map();
const jobResults = new Map(); // jobId -> { pptxPath, slideCount, uploadResult }

db.init();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ── Helpers ─────────────────────────────────────────────────

function isValidDesignURL(url) {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'api.anthropic.com' || parsed.hostname === 'claude.ai') &&
      (parsed.pathname.startsWith('/v1/design/h/') || parsed.pathname.includes('/design/'))
    );
  } catch {
    return false;
  }
}

function genKey() {
  return 'pptx-sk-' + crypto.randomBytes(8).toString('hex');
}

function findHTMLFile(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findHTMLFile(fullPath);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      const base = path.basename(entry.name, '.html').toLowerCase();
      if (base === 'readme') continue;
      return { dir, file: entry.name };
    }
  }
  return null;
}

function makeEmitter(id) {
  return (data) => {
    const clients = sseClients.get(id);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      try { client.write(payload); } catch {}
    }
  };
}

function cleanUpSseEntry(id) {
  const remaining = sseClients.get(id);
  if (remaining && remaining.size === 0) sseClients.delete(id);
}

// ── Background job processor ─────────────────────────────────

function extractDesignName(url) {
  try {
    const parsed = new URL(url);
    // Try open_file param first: ?open_file=Cyber+Hero.html
    const openFile = parsed.searchParams.get('open_file');
    if (openFile) {
      return decodeURIComponent(openFile).replace(/\.(html|htm)$/i, '').replace(/\+/g, ' ');
    }
    // Fallback: extract from path
    const parts = parsed.pathname.split('/');
    const last = parts[parts.length - 1];
    return last || 'Claude Design';
  } catch {
    return 'Claude Design';
  }
}

async function processJob(id, designURL, userEmail, googleToken, hasLicense) {
  const startTime = Date.now();
  const jobDir = path.join(TEMP_DIR, id);
  const designName = extractDesignName(designURL);
  const emit = makeEmitter(id);

  try {
    emit({ stage: 'fetching', message: 'Mendownload bundle...' });
    let response;
    try {
      response = await fetch(designURL);
    } catch (fetchErr) {
      emit({ stage: 'error', message: `Gagal mendownload bundle: ${fetchErr.message}`, retry: true });
      return;
    }
    if (!response.ok) {
      emit({ stage: 'error', message: `Gagal mendownload bundle: HTTP ${response.status}`, retry: false });
      return;
    }

    emit({ stage: 'extracting', message: 'Mengekstrak HTML...' });
    fs.mkdirSync(jobDir, { recursive: true });
    let bundleBuffer;
    try {
      bundleBuffer = await response.buffer();
    } catch (bufErr) {
      emit({ stage: 'error', message: `Gagal membaca bundle: ${bufErr.message}`, retry: true });
      return;
    }

    const isGzip = bundleBuffer[0] === 0x1f && bundleBuffer[1] === 0x8b;
    let tarBuffer = bundleBuffer;
    if (isGzip) {
      try {
        tarBuffer = zlib.gunzipSync(bundleBuffer);
      } catch (e) {
        emit({ stage: 'error', message: 'Gagal dekompresi bundle', retry: false });
        return;
      }
    }

    const tarResult = spawnSync('tar', ['xf', '-', '-C', jobDir], {
      input: tarBuffer,
      maxBuffer: 200 * 1024 * 1024,
    });
    if (tarResult.error || tarResult.status !== 0) {
      emit({ stage: 'error', message: 'Bundle tar rusak atau tidak valid', retry: false });
      return;
    }

    emit({ stage: 'converting', message: 'Mengkonversi slide ke PPTX...' });
    const found = findHTMLFile(jobDir);
    if (!found) {
      emit({ stage: 'error', message: 'Tidak ditemukan file HTML dalam bundle', retry: false });
      return;
    }

    let result;
    try {
      result = await htmlToPptx(found.dir, found.file, emit, !hasLicense);
    } catch (convertErr) {
      emit({ stage: 'error', message: `Gagal mengkonversi slide: ${convertErr.message}`, retry: true });
      await notifyWA(`[PPTX] Gagal konversi (job ${id}): ${convertErr.message}`).catch(() => {});
      return;
    }

    const { pptxBuffer, slideCount, thumbnailPath } = result;
    if (slideCount === 0) {
      emit({ stage: 'error', message: 'Tidak ada slide ditemukan dalam desain', retry: false });
      return;
    }

    emit({ stage: 'uploading', message: 'Menyimpan file...' });
    const pptxPath = path.join(jobDir, 'output.pptx');
    fs.writeFileSync(pptxPath, pptxBuffer);

    let uploadResult = null;
    try {
      uploadResult = await uploadAndConvert(pptxPath, designName, googleToken || null);
      // If using our service account (no user token), share with user's email
      if (!googleToken && userEmail && uploadResult?.fileId) {
        try {
          await shareWithEmail(uploadResult.fileId, userEmail);
          emit({ stage: 'shared', message: `Slides dibagikan ke ${userEmail} sebagai editor` });
        } catch (shareErr) {
          console.error(`[share] Error: ${shareErr.message}`);
        }
      }
    } catch (uploadErr) {
      // Non-fatal — user can still download locally
    }

    const elapsed = Date.now() - startTime;
    jobResults.set(id, { pptxPath, slideCount, uploadResult, thumbnailPath, userEmail, designName });

    emit({
      stage: 'done',
      slideCount,
      elapsed,
      slidesURL: uploadResult?.slidesURL || null,
      thumbnailURL: thumbnailPath ? `/convert/${id}/thumbnail` : null,
      hasLicense,
      message: hasLicense
        ? `${slideCount} slide bersih siap di Google Slides kamu.`
        : `${slideCount} slide siap. Subscribe untuk menghapus watermark.`,
    });

    await notifyWA(`[PPTX] Selesai! ${slideCount} slide (job ${id})`).catch(() => {});

  } catch (err) {
    console.error(`[job ${id}] Unhandled:`, err);
    emit({ stage: 'error', message: `Terjadi kesalahan: ${err.message}`, retry: true });
    await notifyWA(`[PPTX] Error (job ${id}): ${err.message}`).catch(() => {});
  } finally {
    cleanUpSseEntry(id);
  }
}

// ── Routes ──────────────────────────────────────────────────

// Initiate conversion
app.post('/convert', (req, res) => {
  const { designURL, email, googleToken, licenseKey } = req.body || {};
  if (!designURL || typeof designURL !== 'string') {
    return res.status(400).json({ error: 'Field "designURL" wajib diisi' });
  }
  if (!isValidDesignURL(designURL)) {
    return res.status(400).json({ error: 'URL harus dari Claude Design (api.anthropic.com/v1/design/h/...)' });
  }

  // Check if user has a valid license (watermark-free conversion)
  let hasLicense = false;
  if (licenseKey) {
    const license = db.verifyKey(licenseKey);
    if (license && db.checkQuota(license)) {
      hasLicense = true;
    }
  }

  const id = uuidv4();
  sseClients.set(id, new Set());
  processJob(id, designURL, email || null, googleToken || null, hasLicense).catch(err => console.error(`[job ${id}] Fatal:`, err));
  res.json({ id, streamURL: `/convert/${id}/stream` });
});

// SSE progress stream
app.get('/convert/:id/stream', (req, res) => {
  const { id } = req.params;
  if (!sseClients.has(id)) return res.status(404).json({ error: 'Job tidak ditemukan' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');

  const clients = sseClients.get(id);
  clients.add(res);
  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(id);
  });
});

// Get job result (for preview state)
app.get('/convert/:id/result', (req, res) => {
  const { id } = req.params;
  const result = jobResults.get(id);
  if (!result) return res.status(404).json({ error: 'Job belum selesai' });
  res.json({
    slideCount: result.slideCount,
    slidesURL: result.slidesURL,
    thumbnailURL: result.thumbnailPath ? `/convert/${id}/thumbnail` : null,
  });
});

// Serve thumbnail image
app.get('/convert/:id/thumbnail', (req, res) => {
  const { id } = req.params;
  const result = jobResults.get(id);
  if (!result || !result.thumbnailPath) {
    return res.status(404).json({ error: 'Thumbnail tidak tersedia' });
  }
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.sendFile(result.thumbnailPath);
});

// Download PPTX (requires license key)
app.get('/download/:id', async (req, res) => {
  const { id } = req.params;
  const { key, email } = req.query;
  if (!key) return res.status(401).json({ error: 'License key required. Subscribe at nerdstudio.online' });

  const license = db.verifyKey(key);
  if (!license) return res.status(401).json({ error: 'License key tidak valid atau sudah expired' });
  if (!db.checkQuota(license)) {
    return res.status(429).json({ error: 'Batas konversi bulan ini tercapai. Upgrade your plan.' });
  }

  const result = jobResults.get(id);
  if (!result) return res.status(404).json({ error: 'File tidak ditemukan' });

  db.recordConversion(key, result.slideCount);

  const filename = `${(result.designName || 'design').replace(/\s+/g, '-')}-${id.slice(0, 8)}.pptx`;
  res.set('X-Slides-URL', result.uploadResult?.slidesURL || '');
  res.download(result.pptxPath, filename);
});

// Verify license key (for frontend localStorage auto-login)
app.post('/verify-key', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Key required' });
  const license = db.verifyKey(key);
  if (!license) return res.json({ valid: false });
  res.json({
    valid: true,
    tier: license.tier,
    maxMonthly: license.max_monthly,
    conversionsUsed: license.conversions,
    expiresAt: license.expires_at,
  });
});

// Lemon Squeezy webhook
app.post('/webhook/ls', (req, res) => {
  res.json({ ok: true }); // ack immediately

  const signature = req.get('X-Signature');
  if (!signature || !LEMON_SQUEEZY_SECRET) {
    // In dev mode without secret, just log
    console.log('[webhook] No signature verification configured');
  } else {
    const hmac = crypto.createHmac('sha256', LEMON_SQUEEZY_SECRET);
    const digest = hmac.update(req.rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
      console.log('[webhook] Invalid signature');
      return;
    }
  }

  const event = req.body;
  if (event?.meta?.event_name !== 'order_created' && event?.meta?.event_name !== 'subscription_created') return;

  const email = event.data?.attributes?.user_email;
  const variantName = (event.data?.attributes?.variant_name || 'starter').toLowerCase();
  const tiers = { starter: 5, pro: 20, unlimited: -1 };
  const maxMonthly = tiers[variantName] || 5;
  const expiresAt = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString();
  const key = genKey();

  db.createLicense({ key, email, tier: variantName, maxMonthly, expiresAt });
  console.log(`[webhook] License created: ${key} for ${email} (${variantName})`);

  // Fire-and-forget WA notification
  notifyWA(`[PPTX] New subscriber! ${email} — ${variantName} (key: ${key})`).catch(() => {});
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public key (for Lemon Squeezy webhook IP verification if needed)
app.get('/.well-known/lemon-squeezy', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[pptx] Server listening on http://127.0.0.1:${PORT}`);
});
