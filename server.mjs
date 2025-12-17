// Simple local server for testing
// Run with: node server.mjs

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env vars from .env.local
const envPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) process.env[key.trim()] = value.trim();
  });
}

const PTV_DEVID = process.env.PTV_DEVID;
const PTV_KEY = process.env.PTV_KEY;
const PTV_BASE_URL = 'https://timetableapi.ptv.vic.gov.au';

const STOPS = {
  train: { mountWaverley: 1137, syndal: 1190, glenWaverley: 1078 },
  bus: {
    mountWaverley733: 19051,
    syndal703: 16517,
    syndal737: 11385,
    glenWaverley: 11119,
  }
};

const BUS_TRAVEL_TIMES = { 733: 17, 703: 13, 737: 15, 742: 12 };
const TRAIN_TRAVEL = { mountWaverley: 0, syndal: 3, glenWaverley: 6 };
const MIN_TRANSFER = 3;

function signRequest(path) {
  const url = path + (path.includes('?') ? '&' : '?') + `devid=${PTV_DEVID}`;
  const sig = crypto.createHmac('sha1', PTV_KEY).update(url).digest('hex').toUpperCase();
  return `${PTV_BASE_URL}${url}&signature=${sig}`;
}

async function fetchPTV(path) {
  const res = await fetch(signRequest(path));
  return res.json();
}

async function handleAPI(res) {
  try {
    const [trains, mt733, syn703, syn737, gw] = await Promise.all([
      fetchPTV(`/v3/departures/route_type/0/stop/${STOPS.train.mountWaverley}?max_results=5&expand=route`),
      fetchPTV(`/v3/departures/route_type/2/stop/${STOPS.bus.mountWaverley733}?max_results=10&expand=route`),
      fetchPTV(`/v3/departures/route_type/2/stop/${STOPS.bus.syndal703}?max_results=10&expand=route`),
      fetchPTV(`/v3/departures/route_type/2/stop/${STOPS.bus.syndal737}?max_results=10&expand=route`),
      fetchPTV(`/v3/departures/route_type/2/stop/${STOPS.bus.glenWaverley}?max_results=10&expand=route`),
    ]);

    const outbound = trains.departures
      .filter(d => d.direction_id === 6) // Glen Waverley direction
      .map(d => ({ ...d, arrivalTime: new Date(d.estimated_departure_utc || d.scheduled_departure_utc) }))
      .sort((a, b) => a.arrivalTime - b.arrivalTime);

    const nextTrain = outbound[0];
    if (!nextTrain) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No upcoming trains', timestamp: new Date().toISOString() }));
    }

    const trainArrivals = {
      mountWaverley: nextTrain.arrivalTime,
      syndal: new Date(nextTrain.arrivalTime.getTime() + TRAIN_TRAVEL.syndal * 60000),
      glenWaverley: new Date(nextTrain.arrivalTime.getTime() + TRAIN_TRAVEL.glenWaverley * 60000),
    };

    function findBus(deps, routes, trainArr, routeData) {
      const minTime = new Date(trainArr.getTime() + MIN_TRANSFER * 60000);
      const filtered = deps.departures
        .filter(d => routes.some(r => routeData?.[d.route_id]?.route_number === String(r)))
        .map(d => ({ ...d, time: new Date(d.estimated_departure_utc || d.scheduled_departure_utc), route: routeData?.[d.route_id]?.route_number }))
        .filter(d => d.time >= minTime)
        .sort((a, b) => a.time - b.time);
      return filtered[0];
    }

    const options = [];

    // Mount Waverley 733
    const b733 = findBus(mt733, [733], trainArrivals.mountWaverley, mt733.routes);
    if (b733) {
      const arr = new Date(b733.time.getTime() + BUS_TRAVEL_TIMES[733] * 60000);
      options.push({ station: 'Mount Waverley', trainArrival: trainArrivals.mountWaverley.toISOString(),
        bus: { route: '733', departure: b733.time.toISOString(), travelTime: BUS_TRAVEL_TIMES[733] },
        arrivalAtMonash: arr.toISOString(), totalMinutes: Math.round((arr - new Date()) / 60000) });
    }

    // Syndal 703
    const b703 = findBus(syn703, [703], trainArrivals.syndal, syn703.routes);
    if (b703) {
      const arr = new Date(b703.time.getTime() + BUS_TRAVEL_TIMES[703] * 60000);
      options.push({ station: 'Syndal', trainArrival: trainArrivals.syndal.toISOString(),
        bus: { route: '703', departure: b703.time.toISOString(), travelTime: BUS_TRAVEL_TIMES[703] },
        arrivalAtMonash: arr.toISOString(), totalMinutes: Math.round((arr - new Date()) / 60000) });
    }

    // Syndal 737
    const b737s = findBus(syn737, [737], trainArrivals.syndal, syn737.routes);
    if (b737s) {
      const arr = new Date(b737s.time.getTime() + BUS_TRAVEL_TIMES[737] * 60000);
      options.push({ station: 'Syndal', trainArrival: trainArrivals.syndal.toISOString(),
        bus: { route: '737', departure: b737s.time.toISOString(), travelTime: BUS_TRAVEL_TIMES[737] },
        arrivalAtMonash: arr.toISOString(), totalMinutes: Math.round((arr - new Date()) / 60000) });
    }

    // Glen Waverley 742
    const b742 = findBus(gw, [742], trainArrivals.glenWaverley, gw.routes);
    if (b742) {
      const arr = new Date(b742.time.getTime() + BUS_TRAVEL_TIMES[742] * 60000);
      options.push({ station: 'Glen Waverley', trainArrival: trainArrivals.glenWaverley.toISOString(),
        bus: { route: '742', departure: b742.time.toISOString(), travelTime: BUS_TRAVEL_TIMES[742] },
        arrivalAtMonash: arr.toISOString(), totalMinutes: Math.round((arr - new Date()) / 60000) });
    }

    // Glen Waverley 737
    const b737g = findBus(gw, [737], trainArrivals.glenWaverley, gw.routes);
    if (b737g) {
      const arr = new Date(b737g.time.getTime() + BUS_TRAVEL_TIMES[737] * 60000);
      options.push({ station: 'Glen Waverley', trainArrival: trainArrivals.glenWaverley.toISOString(),
        bus: { route: '737', departure: b737g.time.toISOString(), travelTime: BUS_TRAVEL_TIMES[737] },
        arrivalAtMonash: arr.toISOString(), totalMinutes: Math.round((arr - new Date()) / 60000) });
    }

    options.sort((a, b) => new Date(a.arrivalAtMonash) - new Date(b.arrivalAtMonash));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      timestamp: new Date().toISOString(),
      nextTrain: {
        atMountWaverley: trainArrivals.mountWaverley.toISOString(),
        atSyndal: trainArrivals.syndal.toISOString(),
        atGlenWaverley: trainArrivals.glenWaverley.toISOString(),
      },
      recommendation: options[0] || null,
      allOptions: options,
    }));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch data', message: err.message }));
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/departures') {
    return handleAPI(res);
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

const PORT = 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
