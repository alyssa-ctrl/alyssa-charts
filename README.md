# alyssa-charts

Auto-publishing pipeline: Claude builds chart HTML → GitHub Pages hosts it → GitHub Action screenshots it → uploads image to Typefully → creates draft.

---

## Setup (one-time)

### 1. Add these 3 GitHub Secrets
Go to your repo → **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `TYPEFULLY_API_KEY` | `5Ac3BkAfv71iCRPysBcxkL60JPyiGJpW` |
| `TYPEFULLY_SOCIAL_SET_ID` | `278901` |
| `GITHUB_PAGES_BASE` | `https://AlyssaClarkRE.github.io/alyssa-charts` |

### 2. Enable GitHub Actions
Repo → **Settings → Actions → General → Allow all actions** → Save

### 3. Confirm Pages is live
Repo → **Settings → Pages** → should show your site URL

---

## How it works

Every time you push a new `.html` chart file to this repo:

1. GitHub Action spins up headless Chrome
2. Screenshots your chart at exactly **1200×675px**
3. Uploads the PNG to Typefully as a media asset
4. Creates a Typefully **draft** (not yet scheduled) with the image attached
5. Records the draft ID in `chart-manifest.json`

You then open Claude, say "schedule the investment properties post for Tuesday 8am" and Claude will find the draft, add the thread copy, and set the publish time — all via the Typefully MCP.

---

## Workflow per new post

```
1. Claude builds chart HTML + writes tweet thread
2. You drag HTML into this repo (or git push)
3. Action runs automatically (~60 sec)
4. Draft appears in Typefully with image already attached
5. Tell Claude when to schedule it — done
```

---

## Files

| File | Purpose |
|---|---|
| `*.html` | Chart files — one per post |
| `chart-manifest.json` | Tracks processed files, media IDs, draft IDs |
| `.github/workflows/chart-to-typefully.yml` | The Action definition |
| `.github/scripts/screenshot-and-upload.js` | The screenshot + upload logic |
