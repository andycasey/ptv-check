# PTV Train to Bus - Monash Helper

A web app that helps decide which station to get off at when traveling from Burnley to Monash University via the Glen Waverley train line.

## How It Works

The app checks real-time departures and recommends whether to:
- Get off at **Mount Waverley** and take the 733 bus
- Get off at **Syndal** and take the 703 or 737 bus
- Get off at **Glen Waverley** and take the 742 or 737 bus

It considers the next train arrival, bus departure times, and allows 3 minutes for transfers.

## Setup

### 1. Get PTV API Credentials

To use the PTV Timetable API, you need a Developer ID and API Key.

- **API Documentation**: https://timetableapi.ptv.vic.gov.au/swagger/ui/index
- **Data Vic listing**: https://discover.data.vic.gov.au/dataset/ptv-timetable-api

Try emailing `APIKeyRequest@ptv.vic.gov.au` with:
- Your name and email
- Brief description of your intended use

You'll receive:
- **Developer ID** (devid) - a numeric ID
- **API Key** (key) - a UUID string

### 2. Deploy to Vercel

#### Option A: Deploy via GitHub

1. Create a GitHub repository and push this code:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/ptv-check.git
   git push -u origin main
   ```

2. Go to [vercel.com](https://vercel.com) and sign in with GitHub

3. Click "Import Project" and select your repository

4. Add environment variables:
   - `PTV_DEVID` = your developer ID
   - `PTV_KEY` = your API key

5. Click "Deploy"

#### Option B: Deploy via Vercel CLI

1. Install Vercel CLI:
   ```bash
   npm i -g vercel
   ```

2. Deploy:
   ```bash
   vercel
   ```

3. Add environment variables:
   ```bash
   vercel env add PTV_DEVID
   vercel env add PTV_KEY
   ```

4. Redeploy to pick up the environment variables:
   ```bash
   vercel --prod
   ```

### 3. Local Development

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```

2. Edit `.env.local` with your credentials

3. Run the local server:
   ```bash
   node server.mjs
   ```

4. Open http://localhost:3000

(Alternatively, if you have Vercel CLI authenticated: `vercel dev`)

## Troubleshooting

### "PTV API credentials not configured"
Make sure you've added `PTV_DEVID` and `PTV_KEY` as environment variables in Vercel.

### No trains or buses showing
- The app filters for outbound trains on the Glen Waverley line
- Check that it's during operating hours (trains/buses may not run late at night)

### Stop IDs need updating
If the bus stops have changed, you may need to update the stop IDs in `api/departures.js`. You can find stop IDs using the PTV API `/v3/stops/route/{route_id}/route_type/{route_type}` endpoint.

## Files

- `index.html` - Frontend UI
- `api/departures.js` - Serverless function that calls PTV API
- `vercel.json` - Vercel routing configuration
- `package.json` - Project metadata
