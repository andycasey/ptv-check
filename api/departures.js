import crypto from 'crypto';

// PTV API configuration
const PTV_BASE_URL = 'https://timetableapi.ptv.vic.gov.au';

// Route types
const ROUTE_TYPE_TRAIN = 0;
const ROUTE_TYPE_BUS = 2;

// Train station stop IDs (Glen Waverley line)
const STOPS = {
  train: {
    mountWaverley: 1137,
    syndal: 1190,
    glenWaverley: 1078,
  },
  bus: {
    // Bus stops near each train station serving routes to Monash
    mountWaverley733: 19051,  // Mt Waverley SC/Stephensons Rd (95m from station)
    syndal703: 16517,         // Syndal Station/Blackburn Rd
    syndal737: 11385,         // Syndal Station/Coleman Pde
    glenWaverley: 11119,      // Glen Waverley Station/Railway Pde (742 & 737)
  }
};

// Bus routes to Monash Clayton
const BUS_ROUTES = {
  mountWaverley: [733],
  syndal: [703, 737],
  glenWaverley: [742, 737],
};

// Approximate bus travel times to Monash Clayton (minutes)
const BUS_TRAVEL_TIMES = {
  733: 17,
  703: 13,
  737: 15, // average, varies by origin
  742: 12,
};

// Time between train stations (minutes from Mount Waverley)
const TRAIN_TRAVEL_FROM_MT_WAVERLEY = {
  mountWaverley: 0,
  syndal: 3,
  glenWaverley: 6,
};

// Minimum transfer time (minutes)
const MIN_TRANSFER_TIME = 3;

/**
 * Generate HMAC-SHA1 signature for PTV API request
 */
function signRequest(requestPath, devId, apiKey) {
  const url = requestPath + (requestPath.includes('?') ? '&' : '?') + `devid=${devId}`;
  const signature = crypto.createHmac('sha1', apiKey).update(url).digest('hex').toUpperCase();
  return `${PTV_BASE_URL}${url}&signature=${signature}`;
}

/**
 * Fetch data from PTV API
 */
async function fetchPTV(path, devId, apiKey) {
  const signedUrl = signRequest(path, devId, apiKey);
  const response = await fetch(signedUrl);
  if (!response.ok) {
    throw new Error(`PTV API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Get train departures for a stop
 */
async function getTrainDepartures(stopId, devId, apiKey) {
  const path = `/v3/departures/route_type/${ROUTE_TYPE_TRAIN}/stop/${stopId}?max_results=5&expand=run&expand=route`;
  return fetchPTV(path, devId, apiKey);
}

/**
 * Get bus departures for a stop, filtered by routes
 */
async function getBusDepartures(stopId, routeIds, devId, apiKey) {
  const path = `/v3/departures/route_type/${ROUTE_TYPE_BUS}/stop/${stopId}?max_results=10&expand=run&expand=route`;
  const data = await fetchPTV(path, devId, apiKey);

  // Filter to only the routes we care about
  const routeNumbers = routeIds.map(String);
  data.departures = data.departures.filter(dep => {
    const route = data.routes?.[dep.route_id];
    return route && routeNumbers.some(num =>
      route.route_number === num || route.route_short_name === num
    );
  });

  return data;
}

/**
 * Find the next suitable bus after a train arrival
 */
function findNextBus(busDepartures, trainArrival, routes, minTransferMins) {
  const minDepartureTime = new Date(trainArrival.getTime() + minTransferMins * 60 * 1000);

  const suitableBuses = busDepartures
    .map(dep => ({
      ...dep,
      departureTime: new Date(dep.estimated_departure_utc || dep.scheduled_departure_utc),
    }))
    .filter(dep => dep.departureTime >= minDepartureTime)
    .sort((a, b) => a.departureTime - b.departureTime);

  return suitableBuses[0] || null;
}

/**
 * Main API handler
 */
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const devId = process.env.PTV_DEVID;
  const apiKey = process.env.PTV_KEY;

  if (!devId || !apiKey) {
    return res.status(500).json({
      error: 'PTV API credentials not configured',
      message: 'Please set PTV_DEVID and PTV_KEY environment variables',
    });
  }

  try {
    // Fetch all data in parallel
    const [
      mtWaverleyTrains,
      mtWaverleyBuses,
      syndal703Buses,
      syndal737Buses,
      glenWaverleyBuses,
    ] = await Promise.all([
      getTrainDepartures(STOPS.train.mountWaverley, devId, apiKey),
      getBusDepartures(STOPS.bus.mountWaverley733, [733], devId, apiKey),
      getBusDepartures(STOPS.bus.syndal703, [703], devId, apiKey),
      getBusDepartures(STOPS.bus.syndal737, [737], devId, apiKey),
      getBusDepartures(STOPS.bus.glenWaverley, [742, 737], devId, apiKey),
    ]);

    // Get the next outbound train (direction_id 6 = Glen Waverley)
    const outboundTrains = mtWaverleyTrains.departures
      .filter(dep => dep.direction_id === 6) // Glen Waverley direction
      .map(dep => ({
        ...dep,
        arrivalTime: new Date(dep.estimated_departure_utc || dep.scheduled_departure_utc),
      }))
      .sort((a, b) => a.arrivalTime - b.arrivalTime);

    const nextTrain = outboundTrains[0];
    if (!nextTrain) {
      return res.status(200).json({
        error: 'No upcoming trains found',
        timestamp: new Date().toISOString(),
      });
    }

    // Calculate train arrival times at each station
    const trainArrivals = {
      mountWaverley: nextTrain.arrivalTime,
      syndal: new Date(nextTrain.arrivalTime.getTime() + TRAIN_TRAVEL_FROM_MT_WAVERLEY.syndal * 60 * 1000),
      glenWaverley: new Date(nextTrain.arrivalTime.getTime() + TRAIN_TRAVEL_FROM_MT_WAVERLEY.glenWaverley * 60 * 1000),
    };

    // Find best bus option from each station
    const options = [];

    // Mount Waverley - 733
    const mtWaverleyBusList = mtWaverleyBuses.departures.map(dep => ({
      ...dep,
      routeNumber: mtWaverleyBuses.routes?.[dep.route_id]?.route_number || '733',
    }));
    const bus733 = findNextBus(mtWaverleyBusList, trainArrivals.mountWaverley, ['733'], MIN_TRANSFER_TIME);
    if (bus733) {
      const busTime = bus733.departureTime;
      const arrivalAtMonash = new Date(busTime.getTime() + BUS_TRAVEL_TIMES[733] * 60 * 1000);
      options.push({
        station: 'Mount Waverley',
        trainArrival: trainArrivals.mountWaverley.toISOString(),
        bus: {
          route: '733',
          departure: busTime.toISOString(),
          travelTime: BUS_TRAVEL_TIMES[733],
        },
        arrivalAtMonash: arrivalAtMonash.toISOString(),
        totalMinutes: Math.round((arrivalAtMonash - new Date()) / 60000),
      });
    }

    // Syndal - 703 (from Blackburn Rd stop)
    const syndal703List = syndal703Buses.departures.map(dep => ({
      ...dep,
      routeNumber: syndal703Buses.routes?.[dep.route_id]?.route_number || '703',
    }));
    const bus703 = findNextBus(syndal703List, trainArrivals.syndal, ['703'], MIN_TRANSFER_TIME);
    if (bus703) {
      const busTime = bus703.departureTime;
      const arrivalAtMonash = new Date(busTime.getTime() + BUS_TRAVEL_TIMES[703] * 60 * 1000);
      options.push({
        station: 'Syndal',
        trainArrival: trainArrivals.syndal.toISOString(),
        bus: {
          route: '703',
          departure: busTime.toISOString(),
          travelTime: BUS_TRAVEL_TIMES[703],
        },
        arrivalAtMonash: arrivalAtMonash.toISOString(),
        totalMinutes: Math.round((arrivalAtMonash - new Date()) / 60000),
      });
    }

    // Syndal - 737 (from Coleman Pde stop)
    const syndal737List = syndal737Buses.departures.map(dep => ({
      ...dep,
      routeNumber: syndal737Buses.routes?.[dep.route_id]?.route_number || '737',
    }));
    const bus737Syndal = findNextBus(syndal737List, trainArrivals.syndal, ['737'], MIN_TRANSFER_TIME);
    if (bus737Syndal) {
      const busTime = bus737Syndal.departureTime;
      const arrivalAtMonash = new Date(busTime.getTime() + BUS_TRAVEL_TIMES[737] * 60 * 1000);
      options.push({
        station: 'Syndal',
        trainArrival: trainArrivals.syndal.toISOString(),
        bus: {
          route: '737',
          departure: busTime.toISOString(),
          travelTime: BUS_TRAVEL_TIMES[737],
        },
        arrivalAtMonash: arrivalAtMonash.toISOString(),
        totalMinutes: Math.round((arrivalAtMonash - new Date()) / 60000),
      });
    }

    // Glen Waverley - 742, 737
    const glenWaverleyBusList = glenWaverleyBuses.departures.map(dep => ({
      ...dep,
      routeNumber: glenWaverleyBuses.routes?.[dep.route_id]?.route_number || 'unknown',
    }));
    for (const routeNum of ['742', '737']) {
      const routeBuses = glenWaverleyBusList.filter(b => b.routeNumber === routeNum);
      const bus = findNextBus(routeBuses, trainArrivals.glenWaverley, [routeNum], MIN_TRANSFER_TIME);
      if (bus) {
        const busTime = bus.departureTime;
        const travelTime = routeNum === '742' ? BUS_TRAVEL_TIMES[742] : BUS_TRAVEL_TIMES[737];
        const arrivalAtMonash = new Date(busTime.getTime() + travelTime * 60 * 1000);
        options.push({
          station: 'Glen Waverley',
          trainArrival: trainArrivals.glenWaverley.toISOString(),
          bus: {
            route: routeNum,
            departure: busTime.toISOString(),
            travelTime: travelTime,
          },
          arrivalAtMonash: arrivalAtMonash.toISOString(),
          totalMinutes: Math.round((arrivalAtMonash - new Date()) / 60000),
        });
      }
    }

    // Sort by arrival time at Monash
    options.sort((a, b) => new Date(a.arrivalAtMonash) - new Date(b.arrivalAtMonash));

    // Find the best option (earliest arrival)
    const recommendation = options[0] || null;

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      nextTrain: {
        atMountWaverley: trainArrivals.mountWaverley.toISOString(),
        atSyndal: trainArrivals.syndal.toISOString(),
        atGlenWaverley: trainArrivals.glenWaverley.toISOString(),
      },
      recommendation,
      allOptions: options,
    });
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      error: 'Failed to fetch departure data',
      message: error.message,
    });
  }
}
