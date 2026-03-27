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
  const candidates = [process.env.PUPPETEER_EXECUTABLE_PATH,'/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/bin/chromium-browser','/usr/bin/chromium'].filter(Boolean);
  for (const p of candidates) { if (fs.existsSync(p)) { console.log('Chrome: ' + p); return p; } }
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
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
    defaultViewport: { width: 1200, height: 675 }
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(filePath), { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1800));
  const buffer = await page.screenshot({ type: 'png', clip: { x:0, y:0, width:1200, height:675 } });
  await browser.close();
  console.log('Screenshot: ' + buffer.length + ' bytes');
  return buffer;
}

function typefullyPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.typefully.com', path: endpoint, method: 'POST',
      headers: { 'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log('POST ' + endpoint + ' -> ' + res.statusCode);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function putToS3(uploadUrl, buffer) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    // NO extra headers — presigned URL signature was calculated without them
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'PUT',
      headers: {}
    }, res => {
      res.resume();
      res.on('end', () => { console.log('S3 PUT -> ' + res.statusCode); resolve(); });
    });
    req.on('error', reject); req.write(buffer); req.end();
  });
}

function typefullyGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.typefully.com', path: endpoint, method: 'GET',
      head
