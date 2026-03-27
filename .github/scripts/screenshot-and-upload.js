const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const TYPEFULLY_API_KEY = process.env.TYPEFULLY_API_KEY;
const GITHUB_PAGES_BASE = process.env.GITHUB_PAGES_BASE || 'https://alyssa-ctrl.github.io/alyssa-charts';
const TYPEFULLY_SOCIAL_SET_ID = process.env.TYPEFULLY_SOCIAL_SET_ID;
const MANIFEST_PATH = path.join(process.cwd(), 'chart-manifest.json');

function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) { console.log('Found Chrome at: ' + p); return p; }
  }
  throw new Error('No Chrome found!');
}

function getChangedHtmlFiles() {
  try {
    const out = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git ls-files "*.html"').toString().trim();
    return out.split('\n').filter(f => f.endsWith('.html') && fs.existsSync(f));
  } catch { return fs.readdirSync('.').filter(f => f.endsWith('.html')); }
}

async function screenshot(filePath) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1200, height: 675 }
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(filePath), { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1800));
  const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 675 } });
  await browser.close();
  return buffer;
}

function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.typefully.com',
      path: '/v1' + endpoint,
      method,
      headers: {
        'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function uploadImage(pngBuffer, filename) {
  const res = await apiRequest('POST', '/media/upload', {
    file_name: filename, content_type: 'image/png', file_size: pngBuffer.length
  });
  if (res.status !== 200 && res.status !== 201) throw new Error('Upload init failed: ' + JSON.stringify(res.body));
  const { upload_url, media_id } = res.body;
  await new Promise((resolve, reject) => {
    const url = new URL(upload_url);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': pngBuffer.length }
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.write(pngBuffer); req.end();
  });
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await apiRequest('GET', '/media/' + media_id + '/status');
    console.log('Media status: ' + s.body.status);
    if (s.body.status === 'ready') return media_id;
    if (s.body.status === 'error') throw new Error('Media processing failed');
  }
  throw new Error('Timed out waiting for media');
}

async function createDraft(title, pageUrl, mediaId) {
  const text = title + '\n\n📊 Full chart: ' + pageUrl + '\n\n#AI #RealEstate #WealthBuilding #PropTech';
  const res = await apiRequest('POST', '/drafts?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID, {
    draft_title: '[Auto] ' + title,
    platforms: { x: { enabled: true, posts: [{ text, media_ids: mediaId ? [mediaId] : [] }] } }
  });
  if (res.status !== 200 && res.status !== 201) throw new Error('Draft failed: ' + JSON.stringify(res.body));
  return res.body;
}

async function main() {
  console.log('=== Chart to Typefully Pipeline ===');
  const manifest = fs.existsSync(MANIFES
