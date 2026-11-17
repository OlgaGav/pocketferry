# PocketFerry

Move photos and videos between a phone and a computer over Wi-Fi, in either direction.
Nothing is installed on the phone and nothing leaves your home network.

1. Open PocketFerry on the computer. It shows a QR code.
2. Point the phone's camera at the code and tap the link.
3. On the phone, choose a direction:
   - **Send to computer**: pick photos and videos; they land in a folder on the computer.
   - **Get from computer**: save the photos and videos the computer is offering.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer.

```
npm install
npm start        # desktop app window
```

Or without the desktop window (dashboard opens in your browser; installs much faster):

```
npm install --omit=dev
npm run web
```

The first time, the operating system may ask whether PocketFerry may accept
connections on the local network. Choose **Allow**, otherwise the phone cannot reach it.

`npm test` runs the end-to-end checks.

## Build installers for other people

```
npm run dist
```

This produces an installer in `dist/` for the system you run it on: a `.dmg` on macOS,
a setup `.exe` on Windows, an `.AppImage` on Linux. Each must be built on its own system.
To avoid security warnings when others install it, the app must be code-signed
(Apple Developer ID on macOS; Azure Artifact Signing or a code-signing certificate on Windows).

## What it does

### Phone to computer

- Files are saved to `Pictures/PocketFerry` by default; **Change…** picks another folder.
- Large videos are streamed straight to disk, with progress on both phone and computer.
- Each file keeps the date it had on the phone.
- A file that is already in the folder (same name and size) is skipped; a different file
  with the same name is saved as `name (1).jpg`.
- Interrupted or incomplete transfers are discarded, never left half-written.

### Computer to phone

- On the computer, open **To phone** and add photos and videos with the button or by dragging
  them into the window (dragging needs the desktop app). On macOS you can also add a folder:
  the photos and videos directly inside it are added.
- The files stay where they are on the computer. Nothing is copied or moved; the phone
  downloads a copy when you tap **Save** or **Save all**.
- The phone's list updates by itself within a few seconds.
- Saved files go to the phone's **Downloads** folder. Most gallery apps show them in a
  "Download" album.
- The computer shows **Saved to phone ✓** once a file has been delivered in full.
- Downloads can be paused and resumed by the phone's browser.
- The list is forgotten when PocketFerry closes.

Both directions accept photos and videos only (JPEG, PNG, HEIC, WebP, GIF, RAW/DNG, MP4, MOV,
MKV, WebM, 3GP and similar).

## Privacy and safety

- The phone link contains a random code; without it, nothing can be sent or fetched.
  **Make a new code** stops the old link from working.
- The phone can fetch only the files you added to the **To phone** list, never anything
  else on the computer, and it never sees where they are stored.
- The dashboard and its controls answer only the computer itself.
- Transfers use plain HTTP inside your local network. Use it on Wi-Fi you trust
  (home, office), not on public Wi-Fi.
- Closing the app stops all transfers.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Phone says the page can't be reached | Phone and computer must be on the same Wi-Fi (not mobile data, not a guest network). Allow PocketFerry through the computer's firewall. |
| Several networks listed | Use the "Try another network" menu under the QR code. |
| "This link is no longer valid" | Scan the QR code on the computer again. |
| Upload stops when the phone screen locks | Keep the page open and the screen on during long transfers; then tap "Try the failed ones again". |
| "Save all" saves only the first file | The phone's browser is asking for permission to download several files. Choose Allow, then tap the button again. |
| The browser warns that a download is not secure | The file comes from your own computer over your own Wi-Fi. Choose Keep. |
| Saved photos are not in the gallery | Look in the Files app under Downloads, or in the gallery's "Download" album. |

## Project layout

```
server.js              the whole engine: local web server, both transfer directions, settings
public/phone.html      the page the phone opens (send / get)
public/dashboard.html  the computer's view (QR code, From phone, To phone)
main.js                desktop window (Electron) and native file dialogs
preload.js             lets the window learn the path of files dragged into it
cli.js                 run without Electron
test/smoke.js          end-to-end checks: npm test
```

## License

MIT. See [LICENSE](LICENSE).
