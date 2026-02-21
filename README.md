# Vaccination Weather Dashboard (GitHub Pages)

Static webpage that fetches live data from:

- Our World in Data vaccination dataset
- Open-Meteo historical weather API

It visualizes:

- Vaccinations per million trends
- Temperature trends
- Vaccination vs temperature scatter with linear trendline
- Lag correlations (-30 to +30 days)
- Summary table by location

Africa coverage included:

- Nigeria (Abuja)
- Egypt (Cairo)
- Kenya (Nairobi)
- Ethiopia (Addis Ababa)
- South Africa (Pretoria)

## Run locally

```bash
python3 -m http.server 8080
```

Then open: [http://localhost:8080](http://localhost:8080)

## Deploy with GitHub Pages

1. Push this repo to `main`.
2. In GitHub repo settings, open **Settings > Pages**.
3. Set **Source** to **GitHub Actions**.
4. The workflow `.github/workflows/pages.yml` deploys automatically on each push to `main`.

Expected site URL:

- `https://birkneh.github.io/vaccination-weather/`
