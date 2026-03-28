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
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) { console.log('Chrome: ' + p); return p; }
  }
  throw new Error('No Chrome found!');
}

function getChangedHtmlFiles() {
  try {
    const out = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git ls-files "*.html"').toString().trim();
    return out.split('\n').filter(f => f.endsWith('.html') && fs.existsSync(f));
  } catch {
    return fs.readdirSync('.').filter(f => f.endsWith('.html'));
  }
}

async function screenshot(filePath) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1200, height: 675, deviceScaleFactor: 2 }
  });
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(filePath), { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1800));
  const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 2400, height: 1350 } });
  await browser.close();
  console.log('Screenshot: ' + buffer.length + ' bytes');
  return buffer;
}

function typefullyRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization': 'Bearer ' + TYPEFULLY_API_KEY,
      'Content-Type': 'application/json'
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({
      hostname: 'api.typefully.com',
      path: endpoint,
      method,
      headers
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(method + ' ' + endpoint.replace(TYPEFULLY_SOCIAL_SET_ID, '***') + ' -> ' + res.statusCode);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function putToS3(uploadUrl, buffer) {
  return new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: {}
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log('S3 PUT -> ' + res.statusCode + (data ? ' ' + data.substring(0, 200) : ''));
        resolve(res.statusCode);
      });
    });
    req.on('error', reject);
    req.end(buffer);
  });
}

async function waitForMedia(mediaId, maxWaitMs) {
  maxWaitMs = maxWaitMs || 90000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));
    const s = await typefullyRequest('GET', '/v2/social-sets/' + TYPEFULLY_SOCIAL_SET_ID + '/media/' + mediaId, null);
    console.log('Media status: ' + s.body.status);
    if (s.body.status === 'ready') return true;
    if (s.body.status === 'error') { console.log('Media error:', JSON.stringify(s.body)); return false; }
  }
  console.log('Media polling timed out');
  return false;
}

async function uploadImage(pngBuffer, filename) {
  const res = await typefullyRequest('POST', '/v2/social-sets/' + TYPEFULLY_SOCIAL_SET_ID + '/media/upload', { file_name: filename });
  if (res.status !== 200 && res.status !== 201) throw new Error('Media upload init failed (' + res.status + '): ' + JSON.stringify(res.body));
  const { upload_url, media_id } = res.body;
  console.log('media_id: ' + media_id);
  const s3Status = await putToS3(upload_url, pngBuffer);
  if (s3Status >= 400) throw new Error('S3 upload failed with status ' + s3Status);
  const ready = await waitForMedia(media_id, 90000);
  if (!ready) console.log('Warning: media not ready, continuing anyway');
  return media_id;
}

async function createDraft(title, pageUrl, mediaId) {
  const text = title + '\n\n\u{1F4CA} Full chart: ' + pageUrl + '\n\n#AI #RealEstate #WealthBuilding #PropTech';
  const res = await typefullyRequest('POST', '/v2/social-sets/' + TYPEFULLY_SOCIAL_SET_ID + '/drafts', {
    draft_title: '[Auto] ' + title,
    platforms: {
      x: { enabled: true, posts: [{ text, media_ids: mediaId ? [mediaId] : [] }] }
    }
  });
  if (res.status !== 200 && res.status !== 201) throw new Error('Draft failed: ' + JSON.stringify(res.body));
  return res.body;
}

async function main() {
  console.log('=== Chart to Typefully Pipeline ===');
  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    : { charts: {} };
  const files = getChangedHtmlFiles();
  console.log('Files: ' + (files.length ? files.join(', ') : 'none'));
  for (const file of files) {
    const content = fs.readFileSync(file);
    const hash = require('crypto').createHash('md5').update(content).digest('hex');
    if (manifest.charts[file] && manifest.charts[file].hash === hash) {
      console.log('Skipping: ' + file); continue;
    }
    console.log('Processing: ' + file);
    const png = await screenshot(file);
    const mediaId = await uploadImage(png, file.replace('.html', '.png'));
    const title = (content.toString().match(/<title>([^<]+)<\/title>/i) || [])[1] || file;
    const draft = await createDraft(title, GITHUB_PAGES_BASE + '/' + file, mediaId);
    console.log('Draft created: ' + (draft.id || draft.draft_id));
    manifest.charts[file] = {
      hash,
      media_id: mediaId,
      draft_id: draft.id || draft.draft_id,
      processed: new Date().toISOString()
    };
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('Done!');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
