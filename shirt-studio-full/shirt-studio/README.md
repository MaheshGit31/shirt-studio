# Shirt Studio

Design a shirt in the browser, save it, and send an order request. Orders show up at `/admin.html`.

## Deploy on Railway
1. Push this folder to a GitHub repo, then **New Project → Deploy from GitHub repo**.
2. Add a **Volume** to the service, mounted at `/data`.
3. Set variables:
   - `DATA_DIR=/data`
   - `ADMIN_PASSWORD=<something long>`
4. **Settings → Networking → Generate Domain**.

Admin: `https://<your-domain>/admin.html`

## Run locally
```
npm install
ADMIN_PASSWORD=test npm start
```
