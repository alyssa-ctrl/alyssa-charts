/**
 * screenshot-and-upload.js
 * 
 * Runs on every push. For each new/changed HTML chart file:
 *   1. Screenshots it at 1200x675 via headless Chrome
 *   2. Uploads the PNG to Typefully as a media asset
 *   3. Creates (or updates) a Typefully draft with the image attached
 *   4. Records everything in chart-manifest.json so we never double-process
 */

const puppeteer  = require('puppeteer');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const http       = require('http');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TYPEFULLY_API_KEY      = process.env.TYPEFULLY_API_KEY;
const GITHUB_PAGES_BASE      = process.env.GITHUB_PAGES_BASE;   // e.g. https://AlyssaClarkRE.github.io/alyssa-charts
const TYPEFULLY_SOCIAL_SET_ID = process.env.TYPEFULLY_SOCIAL_SET_ID;
const MANIFEST_PATH          = path.join(process.cwd(), 'chart-manifest.json');
const SCREENSHOT_WIDTH       = 1200;
const SCREENSHOT_HEIGHT      = 675;

// ── HELPERS ───────────────────────────────────────────────────────────────────

function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }
  return { charts: {} };
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// Find all HTML files in repo root (non-recursive — keeps it simple)
function findChartFiles() {
  return fs.readdirSync(process.cwd())
    .filter(f => f.endsWith('.html'))
    .map(f => path.join(process.cwd(), f));
}

// Get list of files changed in this push from git
function getChangedFiles() {
  const { execSync } = require('child_process');
  try {
    const out = execSync('git diff --name-only HEAD~1 HEAD').toString().trim();
    return out.split('\n').filter(f => f.endsWith('.html'));
  } catch {
    // First commit — treat all HTML as new
    return findChartFiles().map(f => path.basename(f));
  }
}

// Screenshot a local file using headless Chrome
async function screenshot(filePath) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT }
  });
  const page = await browser.newPage();
  await page.setViewport({ width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT, deviceScaleFactor: 2 });

  const fileUrl = 'file://' + filePath;
  await page.goto(fileUrl, { waitUntil: 'networkidle0', timeout: 15000 });

  // Wait for bar animations to complete (our charts animate on load)
  await new Promise(r => setTimeout(r, 1500));

  const pngBuffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: SCREENSHOT_WIDTH, height: SCREENSHOT_HEIGHT } });
  await browser.close();
  return pngBuffer;
}

// Upload PNG buffer to Typefully, return media_id
async function uploadToTypefully(pngBuffer, filename) {
  // Step 1: Request a presigned upload URL
  const createRes = await typefullyFetch('POST', '/media/upload', {
    file_name: filename,
    content_type: 'image/png',
    file_size: pngBuffer.length
  });

  const { upload_url, media_id } = createRes;

  // Step 2: PUT the PNG directly to the presigned S3 URL
  await putToS3(upload_url, pngBuffer);

  // Step 3: Poll until Typefully confirms processing is complete
  let attempts = 0;
  while (attempts < 20) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await typefullyFetch('GET', `/media/${media_id}/status`);
    if (status.status === 'ready') break;
    if (status.status === 'error') throw new Error(`Typefully media processing failed for ${filename}`);
    attempts++;
  }

  return media_id;
}

// Create a Typefully draft with the image attached
async function createDraft(title, tweetText, mediaId, publishAt) {
  const body = {
    draft_title: title,
    platforms: {
      x: {
        enabled: true,
        posts: [{ text: tweetText, media_ids: mediaId ? [mediaId] : [] }]
      }
    }
  };
  if (publishAt) body.publish_at = publishAt;

  const res = await typefullyFetch('POST', '/drafts', body, true);
  return res;
}

// Generic Typefully API fetch
function typefullyFetch(method, endpoint, body = null, useSocialSet = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://api.typefully.com/v1${endpoint}`);
    if (useSocialSet) url.searchParams.set('social_set_id', TYPEFULLY_SOCIAL_SET_ID);

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'X-API-KEY': `Bearer ${TYPEFULLY_API_KEY}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// PUT a buffer directly to a presigned S3 URL
function putToS3(presignedUrl, buffer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(presignedUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': buffer.length
      }
    };
    const req = lib.request(options, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// Extract a human-readable title from the HTML <title> tag
function extractTitle(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const match = html.match(/<title>([^<]+)<\/title>/i);
  return match ? match[1].trim() : path.basename(filePath, '.html');
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const manifest     = loadManifest();
  const changedFiles = getChangedFiles();

  if (changedFiles.length === 0) {
    console.log('No HTML chart files changed. Nothing to do.');
    return;
  }

  console.log(`Processing ${changedFiles.length} changed chart(s): ${changedFiles.join(', ')}`);

  for (const filename of changedFiles) {
    const filePath  = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) {
      console.log(`  Skipping ${filename} (deleted)`);
      continue;
    }

    const fileHash = require('crypto')
      .createHash('md5')
      .update(fs.readFileSync(filePath))
      .digest('hex');

    // Skip if file hasn't changed since last run
    if (manifest.charts[filename]?.hash === fileHash) {
      console.log(`  Skipping ${filename} (unchanged)`);
      continue;
    }

    console.log(`  📸 Screenshotting ${filename} at ${SCREENSHOT_WIDTH}×${SCREENSHOT_HEIGHT}...`);
    const pngBuffer = await screenshot(filePath);

    const pngFilename = filename.replace('.html', '.png');
    console.log(`  ⬆️  Uploading ${pngFilename} to Typefully...`);
    const mediaId = await uploadToTypefully(pngBuffer, pngFilename);
    console.log(`  ✅ Media ID: ${mediaId}`);

    const title       = extractTitle(filePath);
    const pageUrl     = `${GITHUB_PAGES_BASE}/${filename}`;
    const tweetText   = `${title}\n\n📊 Full interactive chart → ${pageUrl}\n\n#AI #RealEstate #WealthBuilding`;

    console.log(`  📝 Creating Typefully draft...`);
    const draft = await createDraft(
      `[Auto] ${title}`,
      tweetText,
      mediaId,
      null   // null = saved as draft, not scheduled — you schedule via Claude or Typefully UI
    );
    console.log(`  ✅ Draft created: ID ${draft.id || draft.draft_id}`);

    // Record in manifest
    manifest.charts[filename] = {
      hash:      fileHash,
      media_id:  mediaId,
      draft_id:  draft.id || draft.draft_id,
      page_url:  pageUrl,
      processed: new Date().toISOString()
    };
  }

  saveManifest(manifest);
  console.log('\n✅ All done. Manifest updated.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
