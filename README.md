# Your Brain, Externalized

A personal knowledge base. Capture ideas, learnings, decisions and meeting notes, then review and resurface them. Notes sync to a Notion database.

## Run it

```powershell
node server.js
```

Then open http://localhost:8080. No installs needed (Node 18+).

The server matters: Notion's API refuses requests straight from a browser, so `server.js` serves the app and passes its Notion calls through. Opening `index.html` as a file works for local-only notes, but not for Notion sync.

## Online version (Hostinger)

Runs as a separate website on the Hostinger Business plan (Node.js app, entry `server.js`). Its address is kept out of this public repo; it's in `.hostinger/site.json` on your computer (git-ignored) and in hPanel → Websites.

- **Locked:** anywhere other than your own computer, the server requires `APP_PASSCODE`. Without it every page shows "Almost there" and nothing else is served. Wrong passcodes are rate-limited; sign-ins last 180 days. Settings → Notion sync → **Lock app** signs out.
- **Secrets live in hPanel**, never in the code: Websites → this site → Node.js → Environment variables → `APP_PASSCODE` and `NOTION_TOKEN` (optional `SESSION_SECRET`; changing it or the passcode signs every device out).
- **On your phone:** open the address, sign in, then Share → *Add to Home Screen* (iPhone) or ⋮ → *Install app* (Android).
- **Redeploying:** zip `server.js package.json index.html manifest.webmanifest sw.js assets/ icons/`, upload it as `app.zip` to the site's `public_html`, and start a Node.js build from that archive (Node 22, app type "other", entry file `server.js`).

## Connect Notion

1. Create an internal integration at https://www.notion.so/my-integrations (Read, Update and Insert content).
2. On the integration's **Content access** tab, share your knowledge base database with it.
3. In the app, open **Settings → Notion sync**, paste the token and click **Connect & sync**.

The token is stored in your browser only. To keep it off the browser entirely, copy `.env.example` to `.env`, set `NOTION_TOKEN=...`, restart the server, and leave the token box empty. `.env` is git-ignored.

### What syncs

| In Notion | On this device only |
| --- | --- |
| Notes and every field (title, content, type, tags, project, goal, area, context, source, date, star, key insight, status) | Links between notes, Reading list, Someday list, settings |

Deleting a note in the app moves its Notion page to Notion's trash, where it can be restored.

## Shortcuts

`N` new note · `/` search · `R` random note · `Ctrl+Enter` save · `Esc` close

## Art, fonts and icons

- **3D art** – three packs by *creativeproduction.rrgraph* on Creative Fabrica (commercial license via subscription): *Design & Development 3D Icon Pack*, *Mental Health 3D Icons*, *Dreamscape 3D Icons*.
  The images are **not in git** (this repo is public and the license doesn't allow redistributing the files). They live in `assets/art/`, which is git-ignored. To rebuild them on another computer, download the three ZIPs from Creative Fabrica, unzip each into its own folder inside one parent folder (named `Design-Development`, `Mental-Health`, `Dreamscape`), then run:

  ```powershell
  python tools/prep_art.py <parent-folder> assets/art contact-sheet.png
  ```

  Without the art, the app still works; the images just don't show.
- **Fonts** – Fraunces, Bricolage Grotesque and Caveat from Google Fonts.
- **Icons** – [Phosphor](https://phosphoricons.com) (MIT), stored in `assets/vendor/phosphor/` so they work offline.

## Files

- `index.html` – the app
- `server.js` – local server and Notion proxy
- `tools/prep_art.py` – trims and shrinks the 3D art into `assets/art/`
- `index-notion.html` – standalone Notion connection tester
- `index-backup-v2.html` – the previous design, kept for reference
