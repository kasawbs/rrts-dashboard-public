# RRTS Public Dashboard

The Russian River Telemetry Study dashboard is published at:

**https://kasawbs.github.io/rrts-dashboard-public/**

## Public build

The GitHub Pages site is built from the `docs/` folder. The frontend and dashboard data share the same folder:

- `docs/index.html`
- `docs/dashboard.js`
- `docs/styles.css`
- `docs/dashboard_data.json`
- `docs/stations/`
- `docs/aquarius/`
- `docs/explore/`
- `docs/downloads/`
- `docs/assets/`

## Local preview

From this repository:

```powershell
python -m http.server 8000 --directory docs
```

Then open `http://localhost:8000/`.

## Deployment

GitHub Actions deploys the contents of `docs/` to GitHub Pages whenever `main` is updated.
