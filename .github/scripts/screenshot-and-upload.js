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
      headers: { 'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

async function uploadImage(pngBuffer, filename) {
  const res = await typefullyPost('/v1/media/upload?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID, { file_name: filename });
  if (res.status !== 200 && res.status !== 201) throw new Error('Upload init failed (' + res.status + '): ' + JSON.stringify(res.body));
  const { upload_url, media_id } = res.body;
  console.log('media_id: ' + media_id);
  await putToS3(upload_url, pngBuffer);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await typefullyGet('/v1/media/' + media_id + '/status?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID);
    console.log('Media status: ' + JSON.stringify(s.body));
    if (s.body.status === 'ready') return media_id;
    if (s.body.status === 'error') throw new Error('Media processing failed');
  }
  return media_id;
}

async function createDraft(title, pageUrl, mediaId) {
  const text = title + '\n\n📊 Full chart: ' + pageUrl + '\n\n#AI #RealEstate #WealthBuilding #PropTech';
  const res = await typefullyPost('/v1/drafts?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID, {
    draft_title: '[Auto] ' + title,
    platforms: { x: { enabled: true, posts: [{ text, media_ids: mediaId ? [mediaId] : [] }] } }
  });
  if (res.status !== 200 && res.status !== 201) throw new Error('Draft failed: ' + JSON.stringify(res.body));
  return res.body;
}

async function main() {
  console.log('=== Chart to Typefully Pipeline ===');
  const manifest = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : { charts: {} };
  const files = getChangedHtmlFiles();
  console.log('Files: ' + (files.length ? files.join(', ') : 'none'));
  for (const file of files) {
    const content = fs.readFileSync(file);
    const hash = require('crypto').createHash('md5').update(content).digest('hex');
    if (manifest.charts[file]?.hash === hash) { console.log('Skipping: ' + file); continue; }
    console.log('Processing: ' + file);
    const png = await screenshot(file);
    const mediaId = await uploadImage(png, file.replace('.html', '.png'));
    const title = (content.toString().match(/<title>([^<]+)<\/title>/i) || [])[1] || file;
    const draft = await createDraft(title, GITHUB_PAGES_BASE + '/' + file, mediaId);
    console.log('Draft created: ' + (draft.id || draft.draft_id));
    manifest.charts[file] = { hash, media_id: mediaId, draft_id: draft.id || draft.draft_id, processed: new Date().toISOString() };
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('Done!');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
```

Then also update `.github/workflows/chart-to-typefully.yml` — change **only line 35** from:
```
run: node .github/workflows/.github/scripts/screenshot-and-upload.js
```
to:
```
run: node .github/scripts/screenshot-and-upload.js
