const axios = require('axios');
const { getBlobStore } = require('./shared-utils');

/**
 * WEATHER SERVICE - Standalone Netlify Function
 * 
 * Features:
 * - 3-hour cache TTL (separate from player data cache)
 * - Historical forecast tracking (saves every fetch with timestamp)
 * - Post-tournament actual weather fetching
 * - Comparison data for Results tab
 * 
 * Endpoints:
 *   GET ?location=Dublin,Ohio&tournament=Memorial        → Current forecast (cached 3h)
 *   GET ?location=Dublin,Ohio&tournament=Memorial&actual=true → Fetch actual weather (post-tournament)
 *   GET ?tournament=Memorial&history=true                → Get all forecast snapshots + actual
 */

const WEATHER_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

exports.handler = async (event, context) => {
  try {
    const params = event.queryStringParameters || {};
    const { location, tournament, tour = 'pga' } = params;
    const fetchActual = params.actual === 'true';
    const getHistory = params.history === 'true';

    // ==================== MODE 1: Get forecast history ====================
    if (getHistory && tournament) {
      return await getWeatherHistory(tournament, tour, context);
    }

    if (!location) {
      return errorResponse('location parameter required', 400);
    }

    const weatherApiKey = process.env.WEATHER_API_KEY;
    if (!weatherApiKey) {
      return errorResponse('Weather API key not configured', 500);
    }

    const city = location.split(',')[0].trim();
    const tournamentSlug = tournament 
      ? tournament.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : 'unknown';

    // ==================== MODE 2: Fetch actual weather (post-tournament) ====================
    if (fetchActual && tournament) {
      return await fetchAndSaveActualWeather(city, tournamentSlug, tour, weatherApiKey, context);
    }

    // ==================== MODE 3: Current forecast (with 3h cache) ====================
    return await getForecastWithCache(city, tournamentSlug, tour, weatherApiKey, context);

  } catch (error) {
    console.error('[WEATHER] Fatal error:', error.message);
    return errorResponse(error.message, 500);
  }
};

/**
 * Get current forecast, using 3h blob cache
 */
async function getForecastWithCache(city, tournamentSlug, tour, apiKey, context) {
  const cacheKey = `weather-current-${tour}-${tournamentSlug}`;

  // Check cache
  try {
    const store = getBlobStore('weather-cache', context);
    const cached = await store.get(cacheKey, { type: 'json' });

    if (cached && cached.timestamp) {
      const ageMs = Date.now() - cached.timestamp;
      const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);

      if (ageMs < WEATHER_CACHE_TTL_MS) {
        console.log(`[WEATHER] ✅ Cache hit (${ageHours}h old, TTL: 3h)`);
        return successResponse({
          ...cached.weather,
          cached: true,
          cacheAge: ageHours + 'h',
          fetchedAt: cached.fetchedAt
        });
      } else {
        console.log(`[WEATHER] Cache expired (${ageHours}h old)`);
      }
    }
  } catch (err) {
    console.log(`[WEATHER] Cache read error: ${err.message}`);
  }

  // Fetch fresh forecast
  console.log(`[WEATHER] Fetching fresh forecast for ${city}...`);
  const weather = await fetchFromWeatherAPI(city, apiKey);

  if (!weather) {
    return errorResponse('Failed to fetch weather data', 502);
  }

  // Save to cache
  const now = Date.now();
  const fetchedAt = new Date(now).toISOString();

  try {
    const store = getBlobStore('weather-cache', context);
    await store.set(cacheKey, JSON.stringify({
      timestamp: now,
      fetchedAt,
      city,
      tournament: tournamentSlug,
      weather
    }));
    console.log(`[WEATHER] ✅ Cached forecast (key: ${cacheKey})`);
  } catch (err) {
    console.log(`[WEATHER] ⚠️ Cache write failed: ${err.message}`);
  }

  // Also save to history (append snapshot)
  await saveWeatherSnapshot(tournamentSlug, tour, weather, fetchedAt, context);

  return successResponse({
    ...weather,
    cached: false,
    fetchedAt
  });
}

/**
 * Save a forecast snapshot to the history blob
 * Each tournament gets a blob with an array of timestamped forecasts
 */
async function saveWeatherSnapshot(tournamentSlug, tour, weather, fetchedAt, context) {
  const historyKey = `weather-history-${tour}-${tournamentSlug}`;

  try {
    const store = getBlobStore('weather-cache', context);
    let history = { forecasts: [], actual: null };

    try {
      const existing = await store.get(historyKey, { type: 'json' });
      if (existing) history = existing;
    } catch (e) {
      // No existing history, start fresh
    }

    // Add new snapshot
    history.forecasts.push({
      fetchedAt,
      timestamp: Date.now(),
      daily: weather.daily,
      summary: weather.summary
    });

    // Keep max 50 snapshots per tournament (= ~6 days at 3h intervals)
    if (history.forecasts.length > 50) {
      history.forecasts = history.forecasts.slice(-50);
    }

    await store.set(historyKey, JSON.stringify(history));
    console.log(`[WEATHER] 📊 Saved snapshot #${history.forecasts.length} to history`);
  } catch (err) {
    console.log(`[WEATHER] ⚠️ History save failed: ${err.message}`);
  }
}

/**
 * Fetch and save actual weather (called post-tournament)
 * Uses WeatherAPI history endpoint for past dates
 */
async function fetchAndSaveActualWeather(city, tournamentSlug, tour, apiKey, context) {
  const historyKey = `weather-history-${tour}-${tournamentSlug}`;

  try {
    const store = getBlobStore('weather-cache', context);
    let history = { forecasts: [], actual: null };

    try {
      const existing = await store.get(historyKey, { type: 'json' });
      if (existing) history = existing;
    } catch (e) {
      // No history yet
    }

    // Determine tournament dates from the first forecast snapshot
    // or use the last 4 days as fallback
    let dates = [];
    if (history.forecasts.length > 0 && history.forecasts[0].daily?.length > 0) {
      dates = history.forecasts[0].daily.map(d => d.date).filter(Boolean);
    }

    if (dates.length === 0) {
      // Fallback: last Thu-Sun
      const today = new Date();
      for (let i = 3; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
      }
    }

    console.log(`[WEATHER] Fetching actual weather for dates: ${dates.join(', ')}`);

    const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
    const actualDays = [];

    for (let i = 0; i < dates.length; i++) {
      try {
        const response = await axios.get('https://api.weatherapi.com/v1/history.json', {
          params: { key: apiKey, q: city, dt: dates[i] },
          timeout: 8000
        });

        const dayData = response.data?.forecast?.forecastday?.[0];
        if (dayData) {
          actualDays.push({
            day: dayNames[i] || new Date(dates[i]).toLocaleDateString('en-US', { weekday: 'long' }),
            date: dates[i],
            tempHigh: Math.round(dayData.day.maxtemp_f),
            tempLow: Math.round(dayData.day.mintemp_f),
            condition: dayData.day.condition.text,
            windSpeed: Math.round(dayData.day.maxwind_mph),
            avgWindSpeed: Math.round(dayData.day.avgvis_miles), // Note: we'll use hour data for better avg
            chanceOfRain: dayData.day.daily_chance_of_rain,
            totalPrecipIn: dayData.day.totalprecip_in,
            humidity: dayData.day.avghumidity
          });
        }
      } catch (err) {
        console.log(`[WEATHER] Failed to fetch actual for ${dates[i]}: ${err.message}`);
      }
    }

    if (actualDays.length === 0) {
      return errorResponse('Could not fetch actual weather for any tournament dates', 502);
    }

    const actualSummary = actualDays.map(d =>
      `${d.day}: ${d.tempHigh}°F, ${d.condition}, Wind: ${d.windSpeed}mph, Rain: ${d.chanceOfRain}%`
    ).join(' | ');

    history.actual = {
      fetchedAt: new Date().toISOString(),
      daily: actualDays,
      summary: actualSummary
    };

    await store.set(historyKey, JSON.stringify(history));
    console.log(`[WEATHER] ✅ Saved actual weather (${actualDays.length} days)`);

    // Build comparison
    const comparison = buildWeatherComparison(history);

    return successResponse({
      actual: history.actual,
      comparison,
      snapshotCount: history.forecasts.length
    });

  } catch (err) {
    console.error('[WEATHER] Actual weather fetch failed:', err.message);
    return errorResponse(err.message, 500);
  }
}

/**
 * Get weather history for a tournament
 */
async function getWeatherHistory(tournament, tour, context) {
  const tournamentSlug = tournament.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const historyKey = `weather-history-${tour}-${tournamentSlug}`;

  try {
    const store = getBlobStore('weather-cache', context);
    const history = await store.get(historyKey, { type: 'json' });

    if (!history) {
      return successResponse({ forecasts: [], actual: null, comparison: null });
    }

    const comparison = history.actual ? buildWeatherComparison(history) : null;

    return successResponse({
      forecasts: history.forecasts,
      actual: history.actual,
      comparison,
      snapshotCount: history.forecasts.length
    });

  } catch (err) {
    console.error('[WEATHER] History fetch failed:', err.message);
    return errorResponse(err.message, 500);
  }
}

/**
 * Build comparison between earliest forecast and actual weather
 */
function buildWeatherComparison(history) {
  if (!history.actual || !history.forecasts?.length) return null;

  // Use the FIRST forecast (what the model actually used for predictions)
  const firstForecast = history.forecasts[0];
  // And the LAST forecast (most recent before tournament)
  const lastForecast = history.forecasts[history.forecasts.length - 1];
  const actual = history.actual;

  const dayComparisons = actual.daily.map((actualDay, i) => {
    const firstDay = firstForecast.daily?.[i];
    const lastDay = lastForecast.daily?.[i];

    if (!firstDay) return { day: actualDay.day, actual: actualDay, noForecast: true };

    return {
      day: actualDay.day,
      date: actualDay.date,
      actual: {
        tempHigh: actualDay.tempHigh,
        windSpeed: actualDay.windSpeed,
        condition: actualDay.condition,
        chanceOfRain: actualDay.chanceOfRain
      },
      firstForecast: {
        tempHigh: firstDay.tempHigh,
        windSpeed: firstDay.windSpeed,
        condition: firstDay.condition,
        chanceOfRain: firstDay.chanceOfRain,
        fetchedAt: firstForecast.fetchedAt
      },
      lastForecast: lastDay ? {
        tempHigh: lastDay.tempHigh,
        windSpeed: lastDay.windSpeed,
        condition: lastDay.condition,
        chanceOfRain: lastDay.chanceOfRain,
        fetchedAt: lastForecast.fetchedAt
      } : null,
      deviation: {
        tempDiff: actualDay.tempHigh - firstDay.tempHigh,
        windDiff: actualDay.windSpeed - firstDay.windSpeed,
        rainDiff: actualDay.chanceOfRain - firstDay.chanceOfRain
      }
    };
  });

  // Calculate overall accuracy score
  const avgTempDiff = dayComparisons
    .filter(d => d.deviation)
    .reduce((sum, d) => sum + Math.abs(d.deviation.tempDiff), 0) / Math.max(dayComparisons.length, 1);
  const avgWindDiff = dayComparisons
    .filter(d => d.deviation)
    .reduce((sum, d) => sum + Math.abs(d.deviation.windDiff), 0) / Math.max(dayComparisons.length, 1);

  return {
    days: dayComparisons,
    summary: {
      avgTempDeviation: Math.round(avgTempDiff * 10) / 10,
      avgWindDeviation: Math.round(avgWindDiff * 10) / 10,
      forecastCount: history.forecasts.length,
      firstForecastAt: firstForecast.fetchedAt,
      lastForecastAt: lastForecast.fetchedAt
    }
  };
}

/**
 * Fetch forecast from WeatherAPI
 */
async function fetchFromWeatherAPI(city, apiKey) {
  try {
    const response = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: apiKey, q: city, days: 4, aqi: 'no' },
      timeout: 8000
    });

    if (!response.data?.forecast) return null;

    const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
    const daily = response.data.forecast.forecastday.map((day, index) => ({
      day: dayNames[index] || new Date(day.date).toLocaleDateString('en-US', { weekday: 'long' }),
      date: day.date,
      tempHigh: Math.round(day.day.maxtemp_f),
      tempLow: Math.round(day.day.mintemp_f),
      condition: day.day.condition.text,
      windSpeed: Math.round(day.day.maxwind_mph),
      chanceOfRain: day.day.daily_chance_of_rain,
      humidity: day.day.avghumidity
    }));

    const summary = daily.map(d =>
      `${d.day}: ${d.tempHigh}°F, ${d.condition}, Wind: ${d.windSpeed}mph, Rain: ${d.chanceOfRain}%`
    ).join(' | ');

    console.log(`[WEATHER] ${city} - Avg wind ${Math.round(daily.reduce((s, d) => s + d.windSpeed, 0) / daily.length)}mph`);

    return { summary, daily };

  } catch (error) {
    console.error('[WEATHER] API fetch failed:', error.message);
    return null;
  }
}

// ==================== HELPERS ====================

function successResponse(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(data)
  };
}

function errorResponse(message, statusCode = 500) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message })
  };
}
