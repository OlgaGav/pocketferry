'use strict';
// End-to-end checks against a real server on a temporary folder: npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { start, sanitizeName } = require('../server');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketferry-'));
  const dest = path.join(tmp, 'dest');
  const drop = await start({ configDir: path.join(tmp, 'cfg'), dest, port: 0 });
  const base = `http://127.0.0.1:${drop.port}`;
  const local = { 'X-PocketFerry': '1', 'Content-Type': 'application/json' };
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push(`ok   ${name}`); }
    catch (e) { results.push(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
  };

  const st = await (await fetch(`${base}/api/state`)).json();
  const code = drop.code();
  const up = (name, body, extra = {}) => {
    const qs = new URLSearchParams({ name, size: extra.size ?? body.length, lm: extra.lm ?? 0 });
    return fetch(`${base}/api/upload/${extra.code ?? code}?${qs}`, { method: 'POST', body });
  };

  await check('have a code', async () => assert.ok(code && code.length >= 16));

  await check('phone page loads with the code, shows computer name', async () => {
    const r = await fetch(`${base}/u/${code}`);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes(os.hostname()));
  });

  await check('wrong code gets the "no longer valid" page', async () => {
    const r = await fetch(`${base}/u/nope`);
    assert.strictEqual(r.status, 403);
  });

  const photo = crypto.randomBytes(300 * 1024);
  await check('photo upload is saved byte-for-byte and keeps its date', async () => {
    const lm = Date.UTC(2024, 5, 1, 12);
    const r = await up('IMG_0001.jpg', photo, { lm });
    assert.strictEqual(r.status, 200);
    const f = path.join(dest, 'IMG_0001.jpg');
    assert.ok(fs.readFileSync(f).equals(photo));
    assert.strictEqual(fs.statSync(f).mtimeMs, lm);
  });

  await check('large video (64 MB) streams to disk intact', async () => {
    const video = crypto.randomBytes(64 * 1024 * 1024);
    const r = await up('VID_0002.mp4', video);
    assert.strictEqual(r.status, 200);
    const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
    assert.strictEqual(h(fs.readFileSync(path.join(dest, 'VID_0002.mp4'))), h(video));
  });

  await check('same file is reported as already there', async () => {
    const qs = new URLSearchParams({ name: 'IMG_0001.jpg', size: photo.length });
    assert.deepStrictEqual(await (await fetch(`${base}/api/exists/${code}?${qs}`)).json(), { exists: true });
  });

  await check('same name with different content is kept as "name (1)"', async () => {
    const r = await up('IMG_0001.jpg', Buffer.from('different'));
    assert.strictEqual((await r.json()).name, 'IMG_0001 (1).jpg');
    assert.ok(fs.readFileSync(path.join(dest, 'IMG_0001.jpg')).equals(photo));
  });

  await check('upload with a wrong code is refused', async () => {
    const r = await up('x.jpg', Buffer.from('x'), { code: 'wrong' });
    assert.strictEqual(r.status, 403);
    assert.ok(!fs.existsSync(path.join(dest, 'x.jpg')));
  });

  await check('non-media files are refused', async () => {
    for (const n of ['run.exe', 'page.html', 'pic.svg', 'noext']) {
      assert.strictEqual((await up(n, Buffer.from('x'))).status, 415, n);
    }
  });

  await check('file names cannot escape the folder', async () => {
    const r = await up('../../escape.jpg', Buffer.from('x'));
    assert.strictEqual(r.status, 200);
    assert.ok(fs.existsSync(path.join(dest, 'escape.jpg')));
    assert.ok(!fs.existsSync(path.join(tmp, 'escape.jpg')));
    assert.strictEqual(sanitizeName('..\\..\\a/b\\.hidden.png'), 'hidden.png');
  });

  await check('incomplete file (size mismatch) is not kept', async () => {
    const r = await up('short.jpg', Buffer.from('abc'), { size: 999 });
    assert.strictEqual(r.status, 400);
    assert.ok(!fs.existsSync(path.join(dest, 'short.jpg')));
  });

  await check('interrupted transfer leaves nothing behind', async () => {
    await new Promise((resolve) => {
      const req = http.request(`${base}/api/upload/${code}?name=cut.mp4&size=5000000`, { method: 'POST' });
      req.on('error', () => {});
      req.write(Buffer.alloc(100000));
      setTimeout(() => { req.destroy(); setTimeout(resolve, 300); }, 200);
    });
    const left = fs.readdirSync(dest).filter((f) => f.includes('cut') || f.endsWith('.part'));
    assert.deepStrictEqual(left, []);
  });

  await check('dashboard controls refuse requests without the app header', async () => {
    const r = await fetch(`${base}/api/new-code`, { method: 'POST' });
    assert.strictEqual(r.status, 403);
  });

  await check('dashboard refuses a foreign Host header (DNS rebinding)', async () => {
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: drop.port, path: '/api/state', headers: { Host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.strictEqual(status, 404);
  });

  await check('thumbnails only serve files received this session', async () => {
    fs.writeFileSync(path.join(dest, 'private.jpg'), 'x');
    assert.strictEqual((await fetch(`${base}/api/file/private.jpg`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/file/${encodeURIComponent('../cfg/config.json')}`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/file/IMG_0001.jpg`)).status, 200);
  });

  await check('QR code is produced when a network is available', async () => {
    const r = await fetch(`${base}/api/qr.svg`);
    if (st.urls.length) assert.ok((await r.text()).startsWith('<svg'));
    else assert.strictEqual(r.status, 404);
  });

  await check('changing the folder works and new files go there', async () => {
    const other = path.join(tmp, 'other');
    const r = await fetch(`${base}/api/folder`, { method: 'POST', headers: local, body: JSON.stringify({ path: other }) });
    assert.strictEqual(r.status, 200);
    await up('moved.png', Buffer.from('png'));
    assert.ok(fs.existsSync(path.join(other, 'moved.png')));
    const bad = await fetch(`${base}/api/folder`, { method: 'POST', headers: local, body: JSON.stringify({ path: 'relative' }) });
    assert.strictEqual(bad.status, 400);
  });


  // ---------- computer to phone ----------
  const src = path.join(tmp, 'library');
  fs.mkdirSync(path.join(src, 'album'), { recursive: true });
  const bigVideo = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(path.join(src, 'holiday.jpg'), photo);
  fs.writeFileSync(path.join(src, 'Ünï côdé ☀.mp4'), bigVideo);
  fs.writeFileSync(path.join(src, 'notes.txt'), 'private');
  fs.writeFileSync(path.join(src, 'album', 'a.png'), 'png-a');
  fs.writeFileSync(path.join(src, 'album', 'b.webp'), 'webp-b');
  fs.writeFileSync(path.join(src, 'album', 'secret.pdf'), 'pdf');
  const add = (paths) => fetch(`${base}/api/outbox/add`, { method: 'POST', headers: local, body: JSON.stringify({ paths }) }).then((r) => r.json());
  const offered = async (c = drop.code()) => (await fetch(`${base}/api/outbox/${c}`)).json();

  await check('files and folders can be offered to the phone; only photos and videos are accepted', async () => {
    const r = await add([path.join(src, 'holiday.jpg'), path.join(src, 'Ünï côdé ☀.mp4'), path.join(src, 'notes.txt'), path.join(src, 'album'), 'relative.jpg']);
    assert.deepStrictEqual(r, { added: 4, skipped: 2 });
    assert.deepStrictEqual((await add([path.join(src, 'holiday.jpg')])).added, 0, 'no duplicates');
    const { files } = await offered();
    assert.deepStrictEqual(files.map((f) => f.name).sort(), ['a.png', 'b.webp', 'holiday.jpg', 'Ünï côdé ☀.mp4'].sort());
    assert.ok(!JSON.stringify(files).includes(src), 'the phone never sees computer paths');
  });

  await check('the phone downloads an offered file byte-for-byte, with its real name', async () => {
    const { files } = await offered();
    const v = files.find((f) => f.kind === 'video');
    const r = await fetch(`${base}/api/get/${drop.code()}/${v.id}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('content-disposition').includes("filename*=UTF-8''" + encodeURIComponent('Ünï côdé ☀.mp4')));
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(bigVideo));
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(drop.state().outbox.find((f) => f.id === v.id).sent, 1, 'marked as saved to phone');
  });

  await check('downloads can resume (byte ranges) and previews do not count as saved', async () => {
    const { files } = await offered();
    const v = files.find((f) => f.kind === 'video');
    const part = await fetch(`${base}/api/get/${drop.code()}/${v.id}`, { headers: { Range: 'bytes=100-199' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers.get('content-range'), `bytes 100-199/${bigVideo.length}`);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(bigVideo.subarray(100, 200)));
    assert.strictEqual((await fetch(`${base}/api/get/${drop.code()}/${v.id}`, { headers: { Range: `bytes=${bigVideo.length}-` } })).status, 416);
    const p = files.find((f) => f.name === 'holiday.jpg');
    const inline = await fetch(`${base}/api/get/${drop.code()}/${p.id}?inline=1`);
    assert.strictEqual(inline.headers.get('content-type'), 'image/jpeg');
    await inline.arrayBuffer();
    assert.strictEqual((await fetch(`${base}/api/get/${drop.code()}/${v.id}?inline=1`)).status, 404, 'no inline video');
    const opened = await fetch(`${base}/api/get/${drop.code()}/${p.id}?open=1`);
    assert.strictEqual(opened.headers.get('content-type'), 'image/jpeg', 'open shows the photo');
    assert.strictEqual(opened.headers.get('content-disposition'), null, 'open is not a download');
    await opened.arrayBuffer();
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(drop.state().outbox.find((f) => f.id === p.id).sent, 0);
    assert.strictEqual(drop.state().outbox.find((f) => f.id === v.id).sent, 1);
  });

  await check('offered files need the code, and only offered files can be fetched', async () => {
    const { files } = await offered();
    assert.strictEqual((await fetch(`${base}/api/outbox/wrong`)).status, 403);
    assert.strictEqual((await fetch(`${base}/api/get/wrong/${files[0].id}`)).status, 403);
    for (const id of ['nope', '..%2Fnotes.txt', encodeURIComponent(path.join(src, 'notes.txt'))]) {
      assert.strictEqual((await fetch(`${base}/api/get/${drop.code()}/${id}`)).status, 404, id);
    }
    const noHeader = await fetch(`${base}/api/outbox/add`, { method: 'POST', body: JSON.stringify({ paths: [path.join(src, 'notes.txt')] }) });
    assert.strictEqual(noHeader.status, 403);
  });

  await check('a file deleted on the computer disappears from the list; remove and clear work', async () => {
    fs.rmSync(path.join(src, 'album', 'a.png'));
    const gone = (await offered()).files.find((f) => f.name === 'a.png');
    assert.strictEqual((await fetch(`${base}/api/get/${drop.code()}/${gone.id}`)).status, 404);
    assert.ok(!(await offered()).files.some((f) => f.name === 'a.png'));
    const b = (await offered()).files.find((f) => f.name === 'b.webp');
    await fetch(`${base}/api/outbox/remove`, { method: 'POST', headers: local, body: JSON.stringify({ id: b.id }) });
    assert.strictEqual((await offered()).files.length, 2);
    await fetch(`${base}/api/outbox/clear`, { method: 'POST', headers: local });
    assert.strictEqual((await offered()).files.length, 0);
    assert.ok(fs.existsSync(path.join(src, 'holiday.jpg')), 'originals are never touched');
  });

  await check('a new code stops the old one', async () => {
    await fetch(`${base}/api/new-code`, { method: 'POST', headers: local });
    assert.strictEqual((await fetch(`${base}/u/${code}`)).status, 403);
    assert.strictEqual((await up('late.jpg', Buffer.from('x'))).status, 403);
  });

  await drop.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log(process.exitCode ? '\nSome checks failed.' : `\nAll ${results.length} checks passed.`);
})();
