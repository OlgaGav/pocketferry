'use strict';
/*
 * PocketFerry core: a small HTTP server on the local network.
 *  - The computer sees a dashboard at http://localhost:<port>/ (loopback only).
 *  - The phone opens http://<lan-ip>:<port>/u/<code> (from the QR code). From that page it
 *    can send photos and videos to the computer, and save the ones the computer offers.
 * Files are streamed in both directions, so large videos don't use memory.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.dng': 'image/x-adobe-dng',
  '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2', '.mkv': 'video/x-matroska',
  '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mts': 'video/mp2t', '.ts': 'video/mp2t',
};
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.3gp', '.3g2', '.mkv', '.webm', '.avi', '.mts', '.ts']);
// SVG can carry scripts, so it is not accepted from the phone.
const MEDIA_EXT = new Set(Object.keys(MIME).filter((e) => e !== '.svg'));
// Formats a browser can show as a thumbnail on the dashboard.
const PREVIEW_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
// Formats a phone browser can show or play in a tab, for the phone's "Open" button.
const OPEN_EXT = new Set([...PREVIEW_EXT, '.mp4', '.m4v', '.webm', '.3gp']);

function newCode() {
  return crypto.randomBytes(12).toString('base64url');
}

function sameCode(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // no network
      found.push({ name, address: a.address });
    }
  }
  // Home/office Wi-Fi ranges first.
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return found.sort((a, b) => rank(a.address) - rank(b.address));
}

function sanitizeName(raw) {
  let name = String(raw || '').replace(/\\/g, '/');
  name = name.slice(name.lastIndexOf('/') + 1);
  name = name.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').trim().replace(/^\.+/, '');
  if (name.length > 160) {
    const ext = path.extname(name).slice(0, 10);
    name = name.slice(0, 160 - ext.length) + ext;
  }
  return name;
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 10000; i++) {
    const candidate = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${base}-${crypto.randomUUID()}${ext}`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Stream a file with Range support. Returns the byte range that will be sent. */
function sendFile(req, res, file, size, headers) {
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m && (m[1] || m[2]) && size > 0) {
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return null;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) res.end();
  else fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  return { start, end };
}

function defaultOpenFolder(dir) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/**
 * @param {object} [opts]
 * @param {string} [opts.configDir]   where settings are kept
 * @param {string} [opts.dest]        force a destination folder (used by tests)
 * @param {number} [opts.port]        preferred port (0 = any free port)
 * @param {() => Promise<string|null>} [opts.chooseFolder]  native folder picker
 * @param {() => Promise<string[]|null>} [opts.chooseFiles]  native file picker for sending to the phone
 * @param {(dir: string) => void} [opts.openFolder]
 */
async function start(opts = {}) {
  const configDir = opts.configDir || path.join(os.homedir(), '.pocketferry');
  const configFile = path.join(configDir, 'config.json');
  const config = {
    dest: path.join(os.homedir(), 'Pictures', 'PocketFerry'),
    code: newCode(),
    port: 5080,
  };
  try {
    const saved = JSON.parse(await fsp.readFile(configFile, 'utf8'));
    for (const k of ['dest', 'code', 'port']) if (saved[k]) config[k] = saved[k];
  } catch { /* first run */ }
  if (opts.dest) config.dest = opts.dest;
  if (opts.port !== undefined) config.port = opts.port;

  const saveConfig = async () => {
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(configFile, JSON.stringify(config, null, 2));
  };
  try {
    await fsp.mkdir(config.dest, { recursive: true });
  } catch {
    config.dest = path.join(os.homedir(), 'PocketFerry');
    await fsp.mkdir(config.dest, { recursive: true });
  }

  const openFolder = opts.openFolder || defaultOpenFolder;
  const listeners = new Set(); // dashboard event streams
  const recent = []; // newest first
  const outbox = []; // files offered to the phone: { id, path, name, size, kind, preview, sent }
  const MAX_OUTBOX = 2000;
  let port = 0;

  const emit = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(msg);
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const html = (res, status, body) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(body);
  };

  // The dashboard and its controls only answer the computer itself.
  const isLocal = (req) => {
    const ip = req.socket.remoteAddress || '';
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    return loopback && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  };

  const publicItem = (f) => ({ id: f.id, name: f.name, size: f.size, kind: f.kind, preview: f.preview, openable: f.openable, sent: f.sent });

  /** Add files (or the photos and videos directly inside a folder) to the list offered to the phone. */
  async function addToOutbox(paths) {
    let added = 0;
    let skipped = 0;
    const addFile = async (file) => {
      const ext = path.extname(file).toLowerCase();
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile() || !MEDIA_EXT.has(ext) || outbox.length >= MAX_OUTBOX) return void skipped++;
      if (outbox.some((f) => f.path === file)) return;
      outbox.push({
        id: crypto.randomBytes(9).toString('base64url'),
        path: file,
        name: path.basename(file),
        size: st.size,
        kind: VIDEO_EXT.has(ext) ? 'video' : 'photo',
        // Only small, browser-friendly images get a thumbnail.
        preview: PREVIEW_EXT.has(ext) && st.size <= 25 * 1024 * 1024,
        openable: OPEN_EXT.has(ext) && !!MIME[ext],
        sent: 0,
      });
      added++;
    };
    for (const raw of paths) {
      const p = String(raw || '').trim();
      if (!p || !path.isAbsolute(p)) { skipped++; continue; }
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.isDirectory()) {
        const names = (await fsp.readdir(p).catch(() => [])).filter((n) => !n.startsWith('.')).sort();
        for (const n of names) if (MEDIA_EXT.has(path.extname(n).toLowerCase())) await addFile(path.join(p, n));
      } else await addFile(p);
    }
    if (added) emit('state', state());
    return { added, skipped };
  }

  /** Phone asks for one of the offered files. */
  async function handleGet(req, res, id, mode) {
    // mode: 'inline' = thumbnail, 'open' = view in a browser tab, '' = download
    let inline = mode === 'inline' || mode === 'open';
    const item = outbox.find((f) => f.id === id);
    const st = item && (await fsp.stat(item.path).catch(() => null));
    if (!item || !st || !st.isFile()) {
      if (item) { // the file was moved or deleted on the computer
        outbox.splice(outbox.indexOf(item), 1);
        emit('state', state());
      }
      return json(res, 404, { error: 'This file is no longer available on the computer.' });
    }
    if (mode === 'inline' && !item.preview) return json(res, 404, { error: 'No preview' });
    if (mode === 'open' && !item.openable) inline = false; // cannot be shown in a tab: download instead
    const ascii = item.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    const headers = {
      'Content-Type': inline ? MIME[path.extname(item.name).toLowerCase()] : 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Last-Modified': st.mtime.toUTCString(),
    };
    if (!inline) headers['Content-Disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(item.name)}`;
    const range = sendFile(req, res, item.path, st.size, headers);
    if (!range || inline || req.method !== 'GET') return;
    // Count it once the last byte has actually been handed to the phone.
    res.on('finish', () => {
      if (range.end === st.size - 1 && outbox.includes(item)) {
        item.sent++;
        emit('state', state());
      }
    });
  }

  const phoneUrls = () => lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${port}/u/${config.code}` }));

  const state = () => ({
    dest: config.dest,
    urls: phoneUrls(),
    canPickFolder: typeof opts.chooseFolder === 'function',
    canPickFiles: typeof opts.chooseFiles === 'function',
    outbox: outbox.map(publicItem),
    computer: os.hostname(),
    recent,
  });

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1e5) reject(new Error('too large'));
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  async function setFolder(dir) {
    if (!dir || !path.isAbsolute(dir)) throw new Error('Please enter the full path of a folder.');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.access(dir, fs.constants.W_OK);
    config.dest = dir;
    await saveConfig();
    emit('state', state());
  }

  function handleUpload(req, res, q) {
    const name = sanitizeName(q.get('name'));
    const ext = path.extname(name).toLowerCase();
    if (!name || !MEDIA_EXT.has(ext)) {
      req.resume();
      return json(res, 415, { error: 'Only photos and videos can be sent.' });
    }
    const size = Number(q.get('size'));
    const modified = Number(q.get('lm'));
    const dest = config.dest;
    const id = crypto.randomUUID();
    const tmp = path.join(dest, `.${id}.part`);
    const kind = VIDEO_EXT.has(ext) ? 'video' : 'photo';
    let received = 0;
    let lastTick = 0;
    let settled = false;

    const out = fs.createWriteStream(tmp);
    emit('start', { id, name, size, kind });

    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      req.unpipe(out);
      out.destroy();
      fsp.rm(tmp, { force: true }).catch(() => {});
      emit('failed', { id, name });
      if (!res.headersSent && !res.destroyed) json(res, status, { error: message });
      req.resume();
    };

    req.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        emit('progress', { id, received, size });
      }
    });
    req.on('close', () => {
      if (!req.complete) fail(400, 'The transfer was interrupted.');
    });
    req.on('error', () => fail(400, 'The transfer was interrupted.'));
    out.on('error', (e) =>
      fail(507, e.code === 'ENOSPC' ? 'The computer is out of disk space.' : 'The computer could not save this file.'));
    out.on('finish', async () => {
      if (settled) return;
      if (Number.isFinite(size) && size >= 0 && received !== size) {
        return fail(400, 'The file arrived incomplete. Please try again.');
      }
      settled = true;
      try {
        const finalPath = await uniquePath(dest, name);
        await fsp.rename(tmp, finalPath);
        if (Number.isFinite(modified) && modified > 0) {
          const t = new Date(modified);
          await fsp.utimes(finalPath, t, t).catch(() => {}); // keep the date the photo was taken
        }
        const item = {
          id,
          name: path.basename(finalPath),
          size: received,
          kind,
          preview: PREVIEW_EXT.has(ext),
          at: Date.now(),
        };
        recent.unshift(item);
        if (recent.length > 300) recent.length = 300;
        emit('saved', item);
        json(res, 200, { ok: true, name: item.name });
      } catch {
        fsp.rm(tmp, { force: true }).catch(() => {});
        emit('failed', { id, name });
        json(res, 500, { error: 'The computer could not save this file.' });
      }
    });
    req.pipe(out);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => {
      try { return decodeURIComponent(p); } catch { return ''; }
    });
    const [a, b, c, d] = parts;

    // The app icon, shown in the browser tab. Not secret, so no code is needed.
    if (req.method === 'GET' && a === 'icon.svg' && !b) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return res.end(await fsp.readFile(path.join(PUBLIC_DIR, 'icon.svg')));
    }

    // ---------- phone ----------
    if (req.method === 'GET' && a === 'u') {
      if (!sameCode(b || '', config.code)) {
        return html(res, 403, await fsp.readFile(path.join(PUBLIC_DIR, 'expired.html'), 'utf8'));
      }
      const page = await fsp.readFile(path.join(PUBLIC_DIR, 'phone.html'), 'utf8');
      return html(res, 200, page.replace(/\{\{COMPUTER\}\}/g, escapeHtml(os.hostname())));
    }
    // (POST /api/outbox/... is a computer-only control, handled further down.)
    if (a === 'api' && (b === 'upload' || b === 'exists' || b === 'get' || (b === 'outbox' && req.method === 'GET'))) {
      if (!sameCode(c || '', config.code)) {
        req.resume();
        return json(res, 403, { error: 'This code is no longer valid. Scan the QR code again.' });
      }
      if (b === 'exists' && req.method === 'GET') {
        const name = sanitizeName(url.searchParams.get('name'));
        const size = Number(url.searchParams.get('size'));
        let exists = false;
        if (name) {
          try {
            const st = await fsp.stat(path.join(config.dest, name));
            exists = st.isFile() && st.size === size;
          } catch { /* not there */ }
        }
        return json(res, 200, { exists });
      }
      if (b === 'upload' && req.method === 'POST') return handleUpload(req, res, url.searchParams);
      if (b === 'outbox' && req.method === 'GET') return json(res, 200, { files: outbox.map(publicItem) });
      if (b === 'get' && (req.method === 'GET' || req.method === 'HEAD')) return handleGet(req, res, d, url.searchParams.get('inline') === '1' ? 'inline' : url.searchParams.get('open') === '1' ? 'open' : '');
      return json(res, 405, { error: 'Not allowed' });
    }

    // ---------- computer only ----------
    if (!isLocal(req)) {
      req.resume();
      return html(res, 404, await fsp.readFile(path.join(PUBLIC_DIR, 'expired.html'), 'utf8'));
    }

    if (req.method === 'GET' && parts.length === 0) {
      return html(res, 200, await fsp.readFile(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8'));
    }
    if (a !== 'api') return json(res, 404, { error: 'Not found' });

    if (req.method === 'GET') {
      if (b === 'state') return json(res, 200, state());
      if (b === 'qr.svg') {
        const urls = phoneUrls();
        const pick = urls[Number(url.searchParams.get('i')) || 0] || urls[0];
        if (!pick) return json(res, 404, { error: 'No network' });
        const svg = await QRCode.toString(pick.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(svg);
      }
      if (b === 'events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          listeners.delete(res);
        });
        return;
      }
      if (b === 'file') {
        // Thumbnails of files received in this session only.
        const item = recent.find((r) => r.name === c && r.preview);
        if (!item) return json(res, 404, { error: 'Not found' });
        const file = path.join(config.dest, item.name);
        try {
          await fsp.access(file);
        } catch {
          return json(res, 404, { error: 'Not found' });
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(item.name).toLowerCase()],
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=3600',
        });
        return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      }
      if (b === 'out-thumb') {
        const item = outbox.find((f) => f.id === c && f.preview);
        if (!item) return json(res, 404, { error: 'Not found' });
        const st = await fsp.stat(item.path).catch(() => null);
        if (!st) return json(res, 404, { error: 'Not found' });
        sendFile(req, res, item.path, st.size, {
          'Content-Type': MIME[path.extname(item.name).toLowerCase()],
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=3600',
        });
        return;
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST') {
      // A custom header that other websites cannot send without permission.
      if (req.headers['x-pocketferry'] !== '1') return json(res, 403, { error: 'Not allowed' });
      const body = await readJson(req).catch(() => ({}));
      if (b === 'folder') {
        try {
          let dir = body.path;
          if (!dir && opts.chooseFolder) dir = await opts.chooseFolder();
          if (!dir) return json(res, 200, { cancelled: true });
          await setFolder(dir);
          return json(res, 200, { ok: true, dest: config.dest });
        } catch (e) {
          return json(res, 400, { error: e.code ? 'PocketFerry cannot save files in that folder.' : e.message });
        }
      }
      if (b === 'open-folder') {
        openFolder(config.dest);
        return json(res, 200, { ok: true });
      }
      if (b === 'outbox' && c === 'add') {
        let paths = Array.isArray(body.paths) ? body.paths.slice(0, MAX_OUTBOX) : null;
        if (!paths && opts.chooseFiles) paths = await opts.chooseFiles();
        if (!paths || !paths.length) return json(res, 200, { cancelled: true });
        return json(res, 200, await addToOutbox(paths));
      }
      if (b === 'outbox' && (c === 'remove' || c === 'clear')) {
        if (c === 'clear') outbox.length = 0;
        else {
          const i = outbox.findIndex((f) => f.id === body.id);
          if (i >= 0) outbox.splice(i, 1);
        }
        emit('state', state());
        return json(res, 200, { ok: true });
      }
      if (b === 'new-code') {
        config.code = newCode();
        await saveConfig();
        emit('state', state());
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'Not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
      else res.destroy();
    });
  });
  // Long videos on slow Wi-Fi can take a while: never cut a transfer short.
  server.requestTimeout = 0;
  server.timeout = 0;

  const listen = (p) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '0.0.0.0', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  try {
    await listen(config.port);
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    await listen(0); // preferred port is busy: take any free one
  }
  port = server.address().port;
  if (!opts.dest && opts.port === undefined) await saveConfig().catch(() => {});

  // Tell the dashboard when Wi-Fi changes, so the QR code stays correct.
  let lastNet = JSON.stringify(lanAddresses());
  const netWatch = setInterval(() => {
    const now = JSON.stringify(lanAddresses());
    if (now !== lastNet) {
      lastNet = now;
      emit('state', state());
    }
  }, 4000);
  netWatch.unref();

  return {
    port,
    code: () => config.code,
    dashboardUrl: `http://localhost:${port}/`,
    state,
    close: () =>
      new Promise((resolve) => {
        clearInterval(netWatch);
        for (const res of listeners) res.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

module.exports = { start, sanitizeName, MEDIA_EXT };
