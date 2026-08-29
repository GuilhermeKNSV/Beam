// Beam auto-updater — checks GitHub releases for new versions.
import { net } from 'electron';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const GITHUB_REPO = 'GuilhermeKNSV/Beam';
const GITHUB_API = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
const USER_AGENT = 'Beam-Updater';

function log(...args) { console.log('[updater]', ...args); }

function semverParse(v) {
  const m = String(v).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function semverGt(a, b) {
  const va = semverParse(a), vb = semverParse(b);
  if (!va || !vb) return false;
  if (va.major !== vb.major) return va.major > vb.major;
  if (va.minor !== vb.minor) return va.minor > vb.minor;
  return va.patch > vb.patch;
}

export async function checkForUpdate(currentVersion) {
  try {
    const url = GITHUB_API + '?t=' + Date.now();
    const data = await new Promise((resolve, reject) => {
      const req = net.request(url);
      req.setHeader('User-Agent', USER_AGENT);
      req.setHeader('Accept', 'application/vnd.github+json');
      let body = '';
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('GitHub API returned ' + res.statusCode));
          return;
        }
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.abort(); reject(new Error('timeout')); });
      req.end();
    });

    const latestTag = data.tag_name || '';
    const hasUpdate = semverGt(latestTag, currentVersion);
    let downloadUrl = null;
    const asset = (data.assets || []).find(
      (a) => a.name && a.name.endsWith('-Portable.exe') && a.name.includes('Beam-')
    );
    if (asset) downloadUrl = asset.browser_download_url;

    log('check:', { current: currentVersion, latest: latestTag, hasUpdate, asset: asset ? asset.name : null });

    return {
      hasUpdate,
      currentVersion,
      latestVersion: latestTag,
      downloadUrl,
      changelog: (data.body || '').substring(0, 1000),
      error: null,
    };
  } catch (err) {
    log('check failed:', err.message);
    return { hasUpdate: false, currentVersion, latestVersion: '', downloadUrl: null, changelog: '', error: err.message };
  }
}

export async function downloadUpdate(downloadUrl, onProgress) {
  const tempDir = app.getPath('temp');
  const exeName = 'Beam-update-' + Date.now() + '.exe';
  const exePath = path.join(tempDir, exeName);

  return new Promise((resolve) => {
    const file = fs.createWriteStream(exePath);
    const req = net.request(downloadUrl);
    req.setHeader('User-Agent', USER_AGENT);

    let downloaded = 0, total = 0;

    req.on('response', (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(exePath); } catch {}
        downloadUpdate(res.headers.location, onProgress).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(exePath); } catch {}
        resolve({ exePath: '', error: 'Download failed: ' + res.statusCode });
        return;
      }
      total = parseInt(res.headers['content-length'] || '0', 10);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (onProgress && total > 0) { onProgress(downloaded, total); }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        log('downloaded', exePath, (downloaded / 1048576).toFixed(1) + ' MB');
        resolve({ exePath, error: null });
      });
    });
    req.on('error', (err) => {
      file.close();
      try { fs.unlinkSync(exePath); } catch {}
      resolve({ exePath: '', error: err.message });
    });
    req.setTimeout(60000, () => { req.abort(); });
    req.end();
  });
}
