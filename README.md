# Study Pace Timer — Render-ready version

This folder contains the complete hosted app:

- `public/index.html` — the timer and preparation interface
- `server.js` — the small server that imports WOL articles
- `package.json` — tells Render what Node packages to install
- `render.yaml` — optional Render configuration

## Upload to GitHub (no command line needed)

1. Open the GitHub repository you already created.
2. Click **Add file** → **Upload files**.
3. Drag **the contents of this folder** into the upload area. Keep the `public` folder as a folder.
4. Scroll down to the commit area. Enter `Add Study Pace Timer` as the message.
5. Commit/upload the files to the repository's main branch.

Your repository root should show approximately:

```
public/
  index.html
.gitignore
package.json
render.yaml
server.js
README.md
```

## Deploy on Render

1. Go to https://dashboard.render.com/ and create/sign in to a Render account.
2. Choose **New** → **Web Service**.
3. Choose **Git Provider** and connect/authorize GitHub if asked.
4. Find the GitHub repository you created and click **Connect**.
5. Use these settings if Render does not fill them automatically:
   - Language / Runtime: **Node**
   - Build Command: **npm install**
   - Start Command: **npm start**
   - Health Check Path (optional): **/api/health**
6. Choose the **Free** plan if this is just for personal use/testing.
7. Click **Create Web Service** (or **Deploy Web Service**, depending on the current Render wording).
8. When the deploy says **Live**, open the `https://...onrender.com` address shown by Render.

## Test the importer

1. Open the hosted app.
2. Paste a WOL article URL into **WOL article URL**.
3. Click **Import URL**.
4. Review every imported item before using the timing plan. The importer is intentionally “best effort” because WOL page markup can change.

## Updating later

When you receive a new version of the app, upload the changed files to the same GitHub repository. Render normally auto-deploys whenever the connected branch changes.

## Note about Render Free

A free web service can spin down after being idle. The first visit after a period of inactivity may take longer while it wakes up.
