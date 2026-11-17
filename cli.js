#!/usr/bin/env node
'use strict';
// Runs PocketFerry without the desktop window: the dashboard opens in your browser.
const { spawn, execFile, spawnSync } = require('child_process');
const { start, MEDIA_EXT } = require('./server');

// ---- native "choose" windows ----
// A web page is never told where a chosen file is stored, so the dashboard cannot
// use the browser's own file picker. PocketFerry runs on this computer, though, so
// it asks the operating system to show its picker and reads the answer itself.
const EXTS = [...MEDIA_EXT].map((e) => e.slice(1));
let picking = false;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // Cancel ends with an error on every platform: treat it as "nothing chosen".
      const lines = err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve(lines.length ? lines : null);
    });
  });
}

function nativePicker(kind) { // kind: 'files' | 'folder'
  const files = kind === 'files';
  if (process.platform === 'darwin') {
    const types = '{' + EXTS.map((e) => `"${e}"`).join(', ') + '}';
    const script = files
      ? ['activate',
        `set chosen to choose file with prompt "Choose photos and videos to send to the phone" of type ${types} with multiple selections allowed`,
        'set out to ""', 'repeat with f in chosen', 'set out to out & POSIX path of f & linefeed', 'end repeat', 'return out']
      : ['activate', 'return POSIX path of (choose folder with prompt "Where should PocketFerry save photos and videos from the phone?")'];
    return ['osascript', script.flatMap((l) => ['-e', l])];
  }
  if (process.platform === 'win32') {
    const ps = files
      ? `Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d = New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect = $true; $d.Title = 'Choose photos and videos to send to the phone'; $d.Filter = 'Photos and videos|${EXTS.map((e) => '*.' + e).join(';')}'; if ($d.ShowDialog() -eq 'OK') { $d.FileNames }`
      : `Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Where should PocketFerry save photos and videos from the phone?'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`;
    return ['powershell.exe', ['-NoProfile', '-STA', '-Command', ps]];
  }
  if (spawnSync('zenity', ['--version'], { stdio: 'ignore' }).error) return null; // Linux without zenity
  return ['zenity', files
    ? ['--file-selection', '--multiple', '--separator=\n', '--title=Choose photos and videos to send to the phone']
    : ['--file-selection', '--directory', '--title=Where should PocketFerry save photos and videos from the phone?']];
}

function chooser(kind) {
  const cmd = nativePicker(kind);
  if (!cmd) return undefined; // the dashboard falls back to typing a path
  return async () => {
    if (picking) return null; // one window at a time
    picking = true;
    try {
      const lines = await run(cmd[0], cmd[1]);
      return kind === 'files' ? lines : lines && lines[0];
    } finally { picking = false; }
  };
}


start({ chooseFiles: chooser('files'), chooseFolder: chooser('folder') }).then((drop) => {
  console.log(`PocketFerry is running. Dashboard: ${drop.dashboardUrl}`);
  console.log(`Saving to: ${drop.state().dest}`);
  console.log('Press Ctrl+C to stop.');
  if (!process.argv.includes('--no-open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', drop.dashboardUrl] : [drop.dashboardUrl];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
}).catch((e) => {
  console.error('PocketFerry could not start:', e.message);
  process.exit(1);
});
