const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Main prediction endpoint - OPTIMIZED VERSION
 * Fetches data in parallel where possible and reduces logging overhead
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[START] Predictions for ${tour.toUpperCase()} tour`);

    // Step 1: Fetch tournament data
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;

    if (!tournament?.field?.length) {
      throw new Error('No tournament field data available');
    }

    console.log(`[TOURNAMENT] ${tournament.name} (${tournament.field.length} players)`);

    const playerNames = tournament.field.map(p => p.name);

    // Step 2-4: Fetch stats, odds, weather, and course info IN PARALLEL
    const [statsResponse, oddsResponse, weatherData, courseInfo] = await Promise.all([
      // Stats
      axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, 
        { players: playerNames }, 
        { timeout: 30000 }
      ),
      // Odds
      axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, 
        { tournamentName: tournament.name, players: playerNames, tour: tournament.tour }, 
        { timeout: 20000 }
      ),
      // Weather
      fetchWeather(tournament.location),
      // Course info
      axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour}&tournament=${encodeURIComponent(tournament.name)}`, 
        { timeout: 10000 }
      ).then(r => r.data)
    ]);

    const statsData = statsResponse.data;
    const oddsData = oddsResponse.data;

    console.log(`[DATA] Stats: ${statsData.players.length}, Odds: ${oddsData.odds.length}, Course: ${courseInfo.courseName || courseInfo.eventName}`);

    // Step 5: Merge player data (stats + odds)
    const playersWithData = mergePlayerData(statsData.players, oddsData.odds);

    console.log(`[MERGE] ${playersWithData.length} players with complete data`);

    // Step 6: Prepare data for Claude (top 80 players to avoid token limits)
    const topPlayers = playersWithData.slice(0, 80);
    console.log(`[CLAUDE] Analyzing top ${topPlayers.length} players`);

    // Step 7: Call Claude API
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildClaudePrompt(tournament, topPlayers, weatherData.summary, courseInfo);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    });

    // Step 8: Parse Claude response
    const predictions = parseClaudeResponse(message.content[0].text);
    console.log(`[CLAUDE] Generated ${predictions.picks?.length || 0} picks`);

    // Step 9: Enrich predictions with odds breakdown
    enrichPredictionsWithOdds(predictions, playersWithData);

    // Step 10: Calculate costs
    const cost = calculateCost(message.usage);

    // Step 11: Return response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify({
        tournament: {
          name: tournament.name,
          course: tournament.course,
          location: tournament.location,
          dates: tournament.dates,
          tour: tournament.tour
        },
        weather: weatherData.summary,
        dailyForecast: weatherData.daily,
        courseInfo: {
          name: courseInfo.courseName || courseInfo.eventName,
          courseName: courseInfo.courseName,
          location: courseInfo.location,
          par: courseInfo.par,
          yardage: courseInfo.yardage,
          width: courseInfo.width,
          greens: courseInfo.greens,
          rough: courseInfo.rough,
          keyFeatures: courseInfo.keyFeatures || [],
          difficulty: courseInfo.difficulty,
          rewards: courseInfo.rewards || [],
          avgScore: courseInfo.avgScore,
          source: courseInfo.source
        },
        courseAnalysis: {
          type: predictions.courseType || 'Analysis not available',
          weatherImpact: predictions.weatherImpact || 'No significant impact expected',
          keyFactors: predictions.keyFactors || [],
          notes: predictions.courseNotes || ''
        },
        predictions: predictions.picks || predictions,
        generatedAt: new Date().toISOString(),
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
        tokenBreakdown: {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens
        },
        estimatedCost: cost
      })
    };

  } catch (error) {
    console.error('[ERROR]', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to generate predictions',
        message: error.message 
      })
    };
  }
};

/**
 * Fetch weather data with error handling
 */
async function fetchWeather(location) {
  const weatherApiKey = process.env.WEATHER_API_KEY;
  
  if (!weatherApiKey || !location) {
    return { 
      summary: 'Weather data not available', 
      daily: [] 
    };
  }

  try {
    const city = location.split(',')[0].trim();
    const response = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: weatherApiKey, q: city, days: 4, aqi: 'no' },
      timeout: 8000
    });

    if (!response.data?.forecast) {
      return { summary: 'Weather data unavailable', daily: [] };
    }

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
    console.log('[WEATHER] Fetch failed:', error.message);
    return { 
      summary: error.response?.status === 401 ? 'Weather API key invalid' : 'Weather unavailable', 
      daily: [] 
    };
  }
}

/**
 * Merge stats and odds data for all players
 */
function mergePlayerData(statsPlayers, oddsPlayers) {
  return statsPlayers
    .map(stat => {
      const oddsEntry = oddsPlayers.find(o => 
        normalizePlayerName(o.player) === normalizePlayerName(stat.player)
      );
      
      if (!oddsEntry) return null;

      const decimalOdds = americanToDecimal(oddsEntry.odds);
      
      return {
        name: stat.player,
        rank: stat.stats.rank,
        odds: decimalOdds,
        minOdds: oddsEntry.minOdds,
        maxOdds: oddsEntry.maxOdds,
        bestBookmaker: oddsEntry.bestBookmaker,
        worstBookmaker: oddsEntry.worstBookmaker,
        bookmakerCount: oddsEntry.bookmakerCount,
        sgTotal: stat.stats.sgTotal,
        sgOTT: stat.stats.sgOTT,
        sgAPP: stat.stats.sgAPP,
        sgARG: stat.stats.sgARG,
        sgPutt: stat.stats.sgPutt
      };
    })
    .filter(p => p !== null)
    .sort((a, b) => a.odds - b.odds);
}

/**
 * Parse Claude's JSON response with error handling
 */
function parseClaudeResponse(responseText) {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('[PARSE ERROR]', error.message);
    console.error('[RESPONSE]', responseText.substring(0, 500));
    throw new Error('Invalid response format from AI');
  }
}

/**
 * Enrich predictions with odds breakdown from full player dataset
 */
function enrichPredictionsWithOdds(predictions, playersWithData) {
  if (!predictions.picks?.length) return;

  predictions.picks = predictions.picks.map(pick => {
    const playerData = playersWithData.find(p => 
      normalizePlayerName(p.name) === normalizePlayerName(pick.player)
    );
    
    return playerData ? {
      ...pick,
      minOdds: playerData.minOdds,
      maxOdds: playerData.maxOdds,
      bestBookmaker: playerData.bestBookmaker,
      worstBookmaker: playerData.worstBookmaker
    } : pick;
  });
}

/**
 * Calculate API costs
 */
function calculateCost(usage) {
  const inputCost = (usage.input_tokens / 1000000) * 3.00;
  const outputCost = (usage.output_tokens / 1000000) * 15.00;
  const totalCost = inputCost + outputCost;
  
  return {
    inputCost,
    outputCost,
    totalCost,
    formatted: `$${totalCost.toFixed(4)}`
  };
}

/**
 * Convert American odds to decimal
 */
function americanToDecimal(americanOdds) {
  if (!americanOdds || americanOdds === 0) return null;
  return americanOdds > 0 
    ? (americanOdds / 100) + 1 
    : (100 / Math.abs(americanOdds)) + 1;
}

/**
 * Normalize player name for matching
 */
function normalizePlayerName(name) {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  return normalized.split(' ').sort().join(' ');
}

/**
 * Build optimized prompt for Claude
 */
function buildClaudePrompt(tournament, players, weather, courseInfo) {
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  // Build player lists without excessive logging details
  const formatPlayerList = (playerList) => playerList
    .map(p => `${p.name} [${p.odds?.toFixed(1)}] - R${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} P:${p.sgPutt})`)
    .join('\n');

  return `You are a professional golf analyst specializing in finding VALUE picks based on course fit, NOT favorites.

TOURNAMENT:
Name: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName}
Location: ${courseInfo.location}${courseInfo.city ? ` (${courseInfo.city}${courseInfo.state ? ', ' + courseInfo.state : ''})` : ''}
Weather: ${weather}

COURSE INFORMATION:
${courseInfo.par ? `Par: ${courseInfo.par}` : 'Par: Research required'}
${courseInfo.yardage ? `Yardage: ${courseInfo.yardage} yards` : 'Yardage: Research required'}
${courseInfo.width ? `Fairways: ${courseInfo.width}` : ''}
${courseInfo.greens ? `Greens: ${courseInfo.greens}` : ''}
${courseInfo.rough ? `Rough: ${courseInfo.rough}` : ''}
${courseInfo.keyFeatures?.length ? `Key Features: ${courseInfo.keyFeatures.join(', ')}` : ''}
${courseInfo.rewards?.length ? `Rewards: ${courseInfo.rewards.join(', ')}` : ''}

COMPLETE FIELD (${players.length} players):

TOP FAVORITES (odds 5-20) - SKIP THESE - TOO SHORT FOR VALUE:
${formatPlayerList(favorites)}

VALUE ZONE (odds 20-100) - FOCUS HERE FOR MOST PICKS:
${formatPlayerList(midTier)}

LONGSHOTS (odds 100+) - CONSIDER 1-2 IF COURSE FIT IS EXCEPTIONAL:
${formatPlayerList(longshots)}

YOUR TASK:
Select exactly 6 VALUE picks where:
- ALL players should have odds of 20/1 or higher
- At least 4 players should have odds ABOVE 40/1
- Players must have statistical evidence they excel at THIS COURSE TYPE
- Match their SG strengths to course characteristics
- Consider weather conditions
- Provide a range: 20-40/1 (value), 40-80/1 (mid-range), 80-150/1 (longshots)

Return ONLY valid JSON (no markdown):
{
  "courseType": "Description of ${courseInfo.courseName || courseInfo.eventName}${courseInfo.yardage && courseInfo.par ? `: ${courseInfo.yardage} yards, Par ${courseInfo.par}` : ''}, what skills it rewards, why",
  "weatherImpact": "How ${weather} affects strategy at this course",
  "keyFactors": ["3-4 specific course factors", "that determine success"],
  "courseNotes": "2-3 sentences explaining course setup${courseInfo.yardage && courseInfo.par ? ` at ${courseInfo.yardage} yards, Par ${courseInfo.par}` : ''}, what makes it unique, how it creates betting value",
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "SPECIFIC course-fit analysis matching SG stats to exact course demands. Why undervalued. 2-3 sentences max."
    }
  ]
}`;
}
