const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const TYPEFULLY_API_KEY = process.env.TYPEFULLY_API_KEY;
const GITHUB_PAGES_BASE = process.env.GITHUB_PAGES_BASE || 'https://alyssa-ctrl.github.io/alyssa-charts';
const TYPEFULLY_SOCIAL_SET_ID = process.env.TYPEFULLY_SOCIAL_SET_ID;
const MANIFEST_PATH = path.join(process.cwd(), 'chart-manifest.json');

// ── Find Chrome ──────────────────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`  Found Chrome at: ${p}`);
      return p;
    }
  }
  throw new Error('No Chrome found! Tried: ' + candidates.join(', '));
}

// ── Get changed HTML files ───────────────────────────────────────────────────
function getChangedHtmlFiles() {
  try {
    const out = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git ls-files "*.html"')
      .toString().trim();
    return out.split('\n').filter(f => f.endsWith('.html') && fs.existsSync(f));
  } catch {
    return fs.readdirSync('.').filter(f => f.endsWith('.html'));
  }
}

// ── Screenshot ───────────────────────────────────────────────────────────────
async function screenshot(filePath) {
  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1200, height: 675 }
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 675, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(filePath), { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 1800)); // wait for bar animations
  const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 675 } });
  await browser.close();
  console.log(`  Screenshot size: ${buffer.length} bytes`);
  return buffer;
}

// ── Typefully API ─────────────────────────────────────────────────────────────
function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.typefully.com',
      path: `/v1${path}`,
      method,
      headers: {
        'X-API-KEY': `Bearer ${TYPEFULLY_API_KEY}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`  API ${method} ${path} → ${res.statusCode}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Upload PNG to Typefully ───────────────────────────────────────────────────
async function uploadImage(pngBuffer, filename) {
  // Step 1: Get presigned upload URL
  console.log('  Requesting presigned upload URL...');
  const res = await apiRequest('POST', '/media/upload', {
    file_name: filename,
    content_type: 'image/png',
    file_size: pngBuffer.length
  });

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Media upload init failed: ${JSON.stringify(res.body)}`);
  }

  const { upload_url, media_id } = res.body;
  console.log(`  Got media_id: ${media_id}`);

  // Step 2: PUT to S3
  console.log('  Uploading PNG to S3...');
  await new Promise((resolve, reject) => {
    const url = new URL(upload_url);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': pngBuffer.length }
    };
    const req = https.request(options, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(pngBuffer);
    req.end();
  });
  console.log('  S3 upload complete');

  // Step 3: Poll for ready status
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const s = await apiRequest('GET', `/media/${media_id}/status`);
    console.log(`  Media status: ${s.body.status}`);
    if (s.body.status === 'ready') return media_id;
    if (s.body.status === 'error') throw new Error('Typefully media processing failed');
  }
  throw new Error('Timed out waiting for media to be ready');
}

// ── Create Typefully Draft ────────────────────────────────────────────────────
async function createDraft(title, pageUrl, mediaId) {
  const text = `${title}\n\n📊 Full interactive chart → ${pageUrl}\n\n#AI #RealEstate #WealthBuilding #PropTech`;
  const res = await apiRequest('POST', `/drafts?social_set_id=${TYPEFULLY_SOCIAL_SET_ID}`, {
    draft_title: `[Auto] ${title}`,
    platforms: {
      x: {
        enabled: true,
        posts: [{ text, media_ids: mediaId ? [mediaId] : [] }]
      }
    }
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Draft creation failed: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Chart → Typefully Pipeline ===\n');

  const manifest = fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
    : { charts: {} };

  const files = getChangedHtmlFiles();
  console.log(`Changed HTML files: ${files.length > 0 ? files.join(', ') : 'none'}`);

  for (const file of files) {
    console.log(`\nProcessing: ${file}`);

    const content = fs.readFileSync(file);
    const hash = require('crypto').createHash('md5').update(content).digest('hex');

    if (manifest.charts[file]?.hash === hash) {
      console.log('  Unchanged since last run, skipping.');
      continue;
    }

    // Screenshot
    console.log('  Taking screenshot...');
    const png = await screenshot(file);

    // Upload
    const pngName = file.replace('.html', '.png');
    console.log(`  Uploading ${pngName}...`);
    const mediaId = await uploadImage(png, pngName);

    // Extract title from HTML
    const html = content.toString();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : file.replace('.html', '');
    const pageUrl = `${GITHUB_PAGES_BASE}/${file}`;

    // Create draft
    console.log('  Creating Typefully draft...');
    const draft = await createDraft(title, pageUrl, mediaId);
    console.log(`  ✅ Draft created — ID: ${draft.id || draft.draft_id}`);

    manifest.charts[file] = {
      hash,
      media_id: mediaId,
      draft_id: draft.id || draft.draft_id,
      page_url: pageUrl,
      processed: new Date().toISOString()
    };
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\n✅ Pipeline complete.\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
