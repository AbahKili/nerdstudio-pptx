const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const http = require('http');

function startStaticServer(dir, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url === '/' ? '/index.html' : req.url;
      const filePath = path.join(dir, decodeURIComponent(urlPath));
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2', '.woff': 'font/woff',
      };

      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': mime[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });

    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function htmlToPptx(projectDir, htmlFileName, onProgress, watermark) {
  let server;
  let browser;
  const port = 9800 + Math.floor(Math.random() * 100);

  try {
    // Start static server for design files
    server = await startStaticServer(projectDir, port);
    onProgress({ stage: 'extracting' });

    // Find sections in the HTML to know slide count
    const htmlPath = path.join(projectDir, htmlFileName);
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    const slideCount = (htmlContent.match(/<section\s/g) || []).length;
    onProgress({ stage: 'extracting', slideCount });

    // Launch Puppeteer
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    onProgress({ stage: 'converting', current: 0, total: slideCount });

    // Load design page
    await page.goto(`http://127.0.0.1:${port}/${htmlFileName}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Wait for fonts
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 1500));

    // Take thumbnail screenshot for preview
    let thumbnailPath = null;
    try {
      thumbnailPath = path.join(projectDir, 'thumbnail.png');
      await page.screenshot({ path: thumbnailPath, type: 'png', fullPage: false });
    } catch { /* non-fatal */ }

    // Make all slides visible
    await page.evaluate(() => {
      const deck = document.querySelector('deck-stage');
      if (!deck) throw new Error('deck-stage not found');
      deck.setAttribute('noscale', '');

      const shadowRoot = deck.shadowRoot;
      if (shadowRoot) {
        const style = shadowRoot.querySelector('style');
        if (style) {
          style.textContent = style.textContent
            .replace(/opacity:\s*0\s*;/g, 'opacity: 0.01;')
            .replace(/visibility:\s*hidden\s*;/g, 'visibility: visible;');
        }
      }

      const sections = deck.querySelectorAll('section');
      sections.forEach(s => {
        s.style.opacity = '1';
        s.style.visibility = 'visible';
        s.setAttribute('data-deck-active', '');
      });
    });

    onProgress({ stage: 'converting', current: Math.floor(slideCount / 2), total: slideCount });

    // Inject watermark if not licensed
    if (watermark !== false) {
      await page.evaluate(() => {
        const sections = document.querySelectorAll('deck-stage section');
        sections.forEach(s => {
          const overlay = document.createElement('div');
          overlay.className = 'nrd-watermark';
          overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:9999;';
          const text = document.createElement('div');
          text.style.cssText = 'color:rgba(34,197,94,0.12);font-size:clamp(3rem,8vw,8rem);font-weight:900;font-family:sans-serif;transform:rotate(-25deg);white-space:nowrap;letter-spacing:0.05em;';
          text.textContent = 'PREVIEW';
          overlay.appendChild(text);
          s.style.position = s.style.position || 'relative';
          s.appendChild(overlay);
        });
      });
      await new Promise(r => setTimeout(r, 300));
    }

    // Inject dom-to-pptx
    await page.addScriptTag({
      url: 'https://cdn.jsdelivr.net/npm/dom-to-pptx@latest/dist/dom-to-pptx.bundle.js',
    });

    await page.waitForFunction(() => typeof window.domToPptx !== 'undefined', { timeout: 15000 });

    onProgress({ stage: 'converting', current: slideCount, total: slideCount });

    // Run export
    const result = await page.evaluate(async () => {
      const sections = document.querySelectorAll('deck-stage section');
      const { exportToPptx } = window.domToPptx;

      const blob = await exportToPptx(Array.from(sections), {
        fileName: 'output.pptx',
        skipDownload: true,
      });

      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ base64: reader.result.split(',')[1], size: blob.size });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    });

    const pptxBuffer = Buffer.from(result.base64, 'base64');
    onProgress({ stage: 'uploading' });

    return { pptxBuffer, slideCount, thumbnailPath };

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }
}

module.exports = { htmlToPptx };
