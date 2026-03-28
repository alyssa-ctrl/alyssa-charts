const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const TYPEFULLY_API_KEY = process.env.TYPEFULLY_API_KEY;
const GITHUB_PAGES_BASE = process.env.GITHUB_PAGES_BASE || 'https://alyssa-ctrl.github.io/alyssa-charts';
const TYPEFULLY_SOCIAL_SET_ID = process.env.TYPEFULLY_SOCIAL_SET_ID;
const MANIFEST_PATH = path.join(process.cwd(), 'chart-manifest.json');

function fetchFred(seriesId, limit) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.stlouisfed.org/fred/series/observations?series_id=' + seriesId + '&sort_order=desc&limit=' + (limit || 52) + '&file_type=json';
    https.get(url, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var json = JSON.parse(data);
          var obs = json.observations
            .filter(function(o) { return o.value !== '.'; })
            .slice(0, limit || 52)
            .reverse();
          resolve(obs.map(function(o) { return { date: o.date, value: parseFloat(o.value) }; }));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function injectFredData(html) {
  if (html.indexOf('__FRED_MORTGAGE_LABELS__') !== -1) {
    console.log('  Fetching FRED MORTGAGE30US...');
    var data = await fetchFred('MORTGAGE30US', 52);
    var labels = data.map(function(d) { return d.date; });
    var values = data.map(function(d) { return d.value; });
    var latest = data[data.length - 1];
    html = html.replace('"__FRED_MORTGAGE_LABELS__"', JSON.stringify(labels));
    html = html.replace('__FRED_MORTGAGE_LABELS__', JSON.stringify(labels));
    html = html.replace('"__FRED_MORTGAGE_VALUES__"', JSON.stringify(values));
    html = html.replace('__FRED_MORTGAGE_VALUES__', JSON.stringify(values));
    html = html.replace('__FRED_MORTGAGE_LATEST__', latest.value.toFixed(2) + '%');
    html = html.replace('__FRED_MORTGAGE_DATE__', latest.date);
    console.log('  Mortgage rate: ' + latest.value + '% as of ' + latest.date);
  }
  if (html.indexOf('__FRED_FEDFUNDS_LABELS__') !== -1) {
    console.log('  Fetching FRED FEDFUNDS + MORTGAGE30US...');
    var fed = await fetchFred('FEDFUNDS', 36);
    var mort = await fetchFred('MORTGAGE30US', 36);
    html = html.replace('__FRED_FEDFUNDS_LABELS__', JSON.stringify(fed.map(function(d) { return d.date; })));
    html = html.replace('__FRED_FEDFUNDS_VALUES__', JSON.stringify(fed.map(function(d) { return d.value; })));
    html = html.replace('__FRED_MORTGAGE_VALUES2__', JSON.stringify(mort.map(function(d) { return d.value; })));
    html = html.replace('__FRED_FED_LATEST__', fed[fed.length-1].value.toFixed(2) + '%');
    html = html.replace('__FRED_MORT_LATEST2__', mort[mort.length-1].value.toFixed(2) + '%');
  }
  if (html.indexOf('__FRED_HOMEPRICE_LABELS__') !== -1) {
    console.log('  Fetching FRED CSUSHPINSA...');
    var hp = await fetchFred('CSUSHPINSA', 36);
    html = html.replace('__FRED_HOMEPRICE_LABELS__', JSON.stringify(hp.map(function(d) { return d.date; })));
    html = html.replace('__FRED_HOMEPRICE_VALUES__', JSON.stringify(hp.map(function(d) { return d.value; })));
    html = html.replace('__FRED_HOMEPRICE_LATEST__', hp[hp.length-1].value.toFixed(1));
    html = html.replace('__FRED_HOMEPRICE_DATE__', hp[hp.length-1].date);
  }
  return html;
}

function findChrome() {
  var candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ].filter(Boolean);
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) {
      console.log('  Chrome: ' + candidates[i]);
      return candidates[i];
    }
  }
  throw new Error('No Chrome found');
}

function getChangedHtmlFiles() {
  try {
    var out = execSync('git diff --name-only HEAD~1 HEAD 2>/dev/null || git ls-files "*.html"').toString().trim();
    return out.split('\n').filter(function(f) { return f.endsWith('.html') && fs.existsSync(f); });
  } catch(e) {
    return fs.readdirSync('.').filter(function(f) { return f.endsWith('.html'); });
  }
}

async function screenshot(filePath, injectedHtml) {
  var tmpPath = filePath + '.tmp.html';
  fs.writeFileSync(tmpPath, injectedHtml);
  var browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1200, height: 675 }
  });
  var page = await browser.newPage();
  await page.goto('file://' + path.resolve(tmpPath), { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(function(r) { setTimeout(r, 3500); });
  var buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 675 } });
  await browser.close();
  fs.unlinkSync(tmpPath);
  console.log('  Screenshot: ' + buf.length + ' bytes');
  return buf;
}

function tfPost(endpoint, body) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify(body);
    var req = https.request({
      hostname: 'api.typefully.com',
      path: endpoint,
      method: 'POST',
      headers: {
        'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        console.log('  POST ' + endpoint + ' -> ' + res.statusCode);
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function tfGet(endpoint) {
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: 'api.typefully.com',
      path: endpoint,
      method: 'GET',
      headers: { 'X-API-KEY': 'Bearer ' + TYPEFULLY_API_KEY }
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function putS3(url, buf) {
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'PUT', headers: {} },
      function(res) {
        res.resume();
        res.on('end', function() {
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
  var r1 = await tfPost('/v1/media/upload?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID, { file_name: filename });
  if (r1.status !== 200 && r1.status !== 201) throw new Error('Upload init failed: ' + JSON.stringify(r1.body));
  var upload_url = r1.body.upload_url;
  var media_id = r1.body.media_id;
  console.log('  media_id: ' + media_id);
  await putS3(upload_url, buf);
  for (var i = 0; i < 15; i++) {
    await new Promise(function(r) { setTimeout(r, 2000); });
    var s = await tfGet('/v1/media/' + media_id + '/status?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID);
    console.log('  Media status: ' + (s.body.status || JSON.stringify(s.body)));
    if (s.body.status === 'ready') return media_id;
    if (s.body.status === 'error') throw new Error('Media processing error');
  }
  return media_id;
}

async function createDraft(title, pageUrl, mediaId) {
  var text = title + '\n\n📊 Full chart: ' + pageUrl + '\n\n#AI #RealEstate #WealthBuilding #PropTech';
  var r = await tfPost('/v1/drafts?social_set_id=' + TYPEFULLY_SOCIAL_SET_ID, {
    draft_title: '[Auto] ' + title,
    platforms: { x: { enabled: true, posts: [{ text: text, media_ids: mediaId ? [mediaId] : [] }] } }
  });
  if (r.status !== 200 && r.status !== 201) throw new Error('Draft failed: ' + JSON.stringify(r.body));
  return r.body;
}

async function main() {
  console.log('=== Alyssa Charts Pipeline ===');
  var manifest = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : { charts: {} };
  var files = getChangedHtmlFiles();
  console.log('Files to process: ' + (files.length ? files.join(', ') : 'none'));
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    var content = fs.readFileSync(file);
    var hash = require('crypto').createHash('md5').update(content).digest('hex');
    if (manifest.charts[file] && manifest.charts[file].hash === hash) {
      console.log('  Skipping unchanged: ' + file);
      continue;
    }
    console.log('\nProcessing: ' + file);
    var html = content.toString();
    html = await injectFredData(html);
    var png = await screenshot(file, html);
    var mediaId = await uploadImage(png, file.replace('.html', '.png'));
    var titleMatch = content.toString().match(/<title>([^<]+)<\/title>/i);
    var title = titleMatch ? titleMatch[1] : file;
    var draft = await createDraft(title, GITHUB_PAGES_BASE + '/' + file, mediaId);
    console.log('  Draft created: ' + (draft.id || draft.draft_id));
    manifest.charts[file] = { hash: hash, media_id: mediaId, draft_id: draft.id || draft.draft_id, processed: new Date().toISOString() };
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nDone!');
}

main().catch(function(e) { console.error('FATAL:', e); process.exit(1); });
```

Commit with message **"Fix FRED data injection server side"** directly on GitHub. Then in Terminal:
```
cd ~/Documents/GitHub/alyssa-charts
```
```
git pull --rebase
```
```
echo "v6" >> fred-mortgage-rates.html
```
```
git add .
```
```
git commit -m "Retrigger mortgage chart v6"
```
```
git push
