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
    if (fs.existsSync(p)) { console.log('  Chrome: ' + p); return p; }
  }
  throw new Error('No Chrome found');
}

function getChangedHtmlFiles() {
  try {
    const out = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git ls-files "*.html"').toString().trim();
    return out.split('\n').filter(f => f.endsWith('.html') && fs.existsSync(f));
  } catch (e) {
    return fs.readdirSync('.').filter(f => f.endsWith('.html'));
  }
}

async function screenshot(filePath) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--allow-running-insecure-content'
    ],
    defaultViewport: { width: 1200, height: 675 }
  });
  const page = await browser.newPage();
  await page.setBypassCSP(true);
  const fileUrl = 'file://' + path.resolve(filePath);
  console.log('  Opening: ' + fileUrl);
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 30000 });
  try {
    await page.waitForFunction(
      () => document.title === 'CHART_READY' || document.title === 'CHART_ERROR',
      { timeout: 15000 }
    );
    const title = await page.title();
    console.log('  Chart signal: ' + title);
  } catch (e) {
    console.log('  Warning: no CHART_READY signal, screenshotting anyway');
  }
  await new Promise(r => setTimeout(r, 1500));
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 675 } });
  await browser.close();
  console.log('  Screenshot: ' + buf.length + ' bytes');
  return buf;
}

function tfPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.typefully.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log('  POST ' + endpoint + ' -> ' + res.statusCode);
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function tfGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.typefully.com',
      path: endpoint,
      method: 'GET',
      headers: { 'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function putS3(url, buf) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'PUT', headers: {} },
      res => {
        res.resume();
        res.on('end', () => {
          console.log('  S3 PUT -> ' + res.statusCode);
          resolve();
        });
      }
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function uploadImage(buf, filename) {
  const r1 = await tfPost(
    '/v1/media/upload?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID,
    { file_name: filename }
  );
  if (![200, 201].includes(r1.status)) {
    throw new Error('Upload init failed: ' + JSON.stringify(r1.body));
  }
  const { upload_url, media_id } = r1.body;
  console.log('  media_id: ' + media_id);
  await putS3(upload_url, buf);
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await tfGet('/v1/media/' + media_id + '/status?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID);
    console.log('  Media status: ' + (s.body.status || JSON.stringify(s.body)));
    if (s.body.status === 'ready') return media_id;
    if (s.body.status === 'error') throw new Error('Media processing error');
  }
  return media_id;
}

async function createDraft(title, pageUrl, mediaId) {
  const text = title + '\n\n📊 Full chart: ' + pageUrl + '\n\n#AI #RealEstate #WealthBuilding #PropTech';
  const r = await tfPost(
    '/v1/drafts?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID,
    {
      draft_title: '[Auto] ' + title,
      platforms: {
        x: {
          enabled: true,
          posts: [{ text: text, media_ids: mediaId ? [mediaId] : [] }]
        }
      }
    }
  );
  if (![200, 201].includes(r.status)) {
    throw new Error('Draft creation failed: ' + JSON.stringify(r.body));
  }
  return r.body;
}

async function main() {
  console.log('=== Alyssa Charts Pipeline ===');
  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    : { charts: {} };
  const files = getChangedHtmlFiles();
  console.log('Files to process: ' + (files.length ? files.join(', ') : 'none'));
  for (const file of files) {
    const content = fs.readFileSync(file);
    const hash = require('crypto').createHash('md5').update(content).digest('hex');
    if (manifest.charts[file] && manifest.charts[file].hash === hash) {
      console.log('  Skipping unchanged: ' + file);
      continue;
    }
    console.log('\nProcessing: ' + file);
    const png = await screenshot(file);
    const mediaId = await uploadImage(png, file.replace('.html', '.png'));
    const titleMatch = content.toString().match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : file;
    const draft = await createDraft(title, GITHUB_PAGES_BASE + '/' + file, mediaId);
    console.log('  Draft created: ' + (draft.id || draft.draft_id));
    manifest.charts[file] = {
      hash: hash,
      media_id: mediaId,
      draft_id: draft.id || draft.draft_id,
      processed: new Date().toISOString()
    };
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nDone!');
}

main().catch(function(e) {
  console.error('FATAL:', e);
  process.exit(1);
});
```

Commit with message **"Clean script final"** directly on GitHub. Then in Terminal run these one at a time:
```
cd ~/Documents/GitHub/alyssa-charts
```
```
git pull --rebase
```
```
git push
