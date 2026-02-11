const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const {
  normalizePlayerName,
  formatAmericanOdds,
  analyzeCourseSkillDemands,
  analyzeWeatherConditions,
  calculateClaudeCost
} = require('./shared-utils');

/**
 * Analyze a single player's course fit, form, odds value, and weather impact
 * Returns structured analysis from Claude AI
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { playerName, tour } = body;

    if (!playerName) {
      return createResponse(400, { error: 'Player name required' });
    }

    console.log(`[PLAYER] Analyzing: ${playerName} (${tour || 'pga'})`);
    const baseUrl = process.env.URL || 'http://localhost:8888';

    // Fetch all data in parallel where possible
    const tournamentPromise = axios.get(
      `${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour || 'pga'}`,
      { timeout: 15000 }
    );

    const tournament = (await tournamentPromise).data;
    console.log(`[PLAYER] Tournament: ${tournament.name}`);

    // Fetch stats, odds (from DataGolf directly), course info in parallel
    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : (tour || 'pga');
    
    const [statsResult, oddsResult, courseResult] = await Promise.allSettled([
      axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, { players: [playerName] }, { timeout: 15000 }),
      axios.get(`https://feeds.datagolf.com/betting-tools/outrights?tour=${apiTour}&market=win&odds_format=american&file_format=json&key=${apiKey}`, { timeout: 10000 }),
      axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour || 'pga'}&tournament=${encodeURIComponent(tournament.name)}`, { timeout: 10000 })
    ]);

    const playerStats = statsResult.status === 'fulfilled' ? statsResult.value.data.players?.[0] : null;
    const courseInfo = courseResult.status === 'fulfilled' ? courseResult.value.data : { courseName: tournament.course };

    // Extract player odds from DataGolf outrights response
    let playerOdds = null;
    if (oddsResult.status === 'fulfilled' && oddsResult.value.data) {
      const oddsData = oddsResult.value.data;
      
      // DEBUG: Log response structure
      const oddsKeys = Object.keys(oddsData);
      console.log(`[PLAYER] Outrights response keys: [${oddsKeys.join(', ')}]`);
      
      // The odds might be in different fields
      let oddsEntries = oddsData.odds || oddsData.players || oddsData.data || [];
      
      // If it's not an array, maybe the response IS the array
      if (!Array.isArray(oddsEntries) && Array.isArray(oddsData)) {
        oddsEntries = oddsData;
      }
      
      // Or maybe entries are in a nested structure
      if (!Array.isArray(oddsEntries) || oddsEntries.length === 0) {
        // Try to find array in response
        for (const key of oddsKeys) {
          if (Array.isArray(oddsData[key]) && oddsData[key].length > 0) {
            console.log(`[PLAYER] Found odds array in key: "${key}" (${oddsData[key].length} entries)`);
            oddsEntries = oddsData[key];
            break;
          }
        }
      }
      
      console.log(`[PLAYER] Odds entries: ${oddsEntries.length}, type: ${typeof oddsEntries[0]}`);
      
      // Log first entry to see field names
      if (oddsEntries.length > 0) {
        const first = oddsEntries[0];
        console.log(`[PLAYER] First entry keys: [${Object.keys(first).join(', ')}]`);
        // Log a few player names to see format
        const sampleNames = oddsEntries.slice(0, 5).map(e => e.player_name || e.name || e.player || 'unknown');
        console.log(`[PLAYER] Sample names: ${sampleNames.join(', ')}`);
      }
      
      // Search for the player - try multiple name fields
      const playerEntry = oddsEntries.find(entry => {
        const entryName = entry.player_name || entry.name || entry.player || '';
        return normalizePlayerName(entryName) === normalizePlayerName(playerName);
      });

      if (playerEntry) {
        console.log(`[PLAYER] Found player entry: ${JSON.stringify(playerEntry).substring(0, 300)}`);
        
        // Collect odds from all bookmaker columns
        const bookOdds = [];
        const skipKeys = ['player_name', 'name', 'player', 'dg_id', 'dk_salary', 'fd_salary', 
                         'baseline_history_fit', 'datagolf', 'am', 'country'];
        
        for (const [key, val] of Object.entries(playerEntry)) {
          if (skipKeys.includes(key)) continue;
          if (typeof val === 'number' && val !== 0) {
            bookOdds.push(val);
          }
        }
        
        console.log(`[PLAYER] Book odds found: ${bookOdds.length} (${bookOdds.slice(0, 5).join(', ')}...)`);
        
        if (bookOdds.length > 0) {
          const avgOdds = Math.round(bookOdds.reduce((a, b) => a + b, 0) / bookOdds.length);
          playerOdds = {
            odds: avgOdds,
            minOdds: Math.min(...bookOdds),
            maxOdds: Math.max(...bookOdds),
            bookmakerCount: bookOdds.length,
            dgModel: playerEntry.datagolf || null
          };
        }
      } else {
        // Log what we searched for vs what exists
        const normalizedSearch = normalizePlayerName(playerName);
        console.log(`[PLAYER] Player "${playerName}" (normalized: "${normalizedSearch}") not found in ${oddsEntries.length} entries`);
        // Try to find close matches
        const closeMatches = oddsEntries
          .map(e => ({ name: e.player_name || e.name || '', norm: normalizePlayerName(e.player_name || e.name || '') }))
          .filter(e => e.norm.includes('berg') || e.norm.includes('ludvig'))
          .slice(0, 5);
        if (closeMatches.length > 0) {
          console.log(`[PLAYER] Close matches: ${closeMatches.map(m => `"${m.name}" → "${m.norm}"`).join(', ')}`);
        }
      }
    } else {
      console.log(`[PLAYER] Outrights fetch failed: ${oddsResult.status === 'rejected' ? oddsResult.reason?.message : 'no data'}`);
    }

    if (playerStats) console.log(`[PLAYER] Stats: R${playerStats.stats?.rank || '?'}, SG:${playerStats.stats?.sgTotal?.toFixed(2) || 'N/A'}`);
    if (playerOdds) console.log(`[PLAYER] Odds: ${formatAmericanOdds(playerOdds.odds)}`);

    // Fetch weather
    let weatherSummary = 'Weather data not available';
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const location = tournament.location.split(',')[0].trim();
        const weatherResponse = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
          params: { key: weatherApiKey, q: location, days: 4, aqi: 'no' },
          timeout: 8000
        });
        if (weatherResponse.data?.forecast) {
          const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
          weatherSummary = weatherResponse.data.forecast.forecastday.map((day, i) => {
            const d = day.day;
            return `${dayNames[i] || 'Day'}: ${Math.round(d.maxtemp_f)}°F, ${d.condition.text}, Wind: ${Math.round(d.maxwind_mph)}mph, Rain: ${d.daily_chance_of_rain}%`;
          }).join(' | ');
        }
      }
    } catch (err) {
      console.log(`[PLAYER] Weather failed: ${err.message}`);
    }

    // Build analysis context
    const courseDemands = analyzeCourseSkillDemands(courseInfo);
    const weatherAnalysis = analyzeWeatherConditions(weatherSummary);
    const stats = playerStats?.stats || {};
    const sgProfile = `SG Total: ${stats.sgTotal?.toFixed(2) || 'N/A'} (OTT: ${stats.sgOTT?.toFixed(2) || 'N/A'}, APP: ${stats.sgAPP?.toFixed(2) || 'N/A'}, ARG: ${stats.sgARG?.toFixed(2) || 'N/A'}, Putt: ${stats.sgPutt?.toFixed(2) || 'N/A'})`;
    const oddsInfo = playerOdds ? `${formatAmericanOdds(playerOdds.odds)} avg across ${playerOdds.bookmakerCount} books (range: ${formatAmericanOdds(playerOdds.minOdds)} to ${formatAmericanOdds(playerOdds.maxOdds)})${playerOdds.dgModel ? ` | DataGolf model: ${formatAmericanOdds(playerOdds.dgModel)}` : ''}` : 'Odds not available';

    // Call Claude for analysis
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are an expert golf betting analyst. Analyze this player for the upcoming tournament.

PLAYER: ${playerName}
WORLD RANKING: ${stats.rank || 'Unknown'}
SG PROFILE: ${sgProfile}
ODDS: ${oddsInfo}

TOURNAMENT: ${tournament.name}
COURSE: ${courseInfo.courseName || tournament.course} | ${courseInfo.yardage || '?'}y Par ${courseInfo.par || '?'}
COURSE DEMANDS: ${courseDemands}
WEATHER: ${weatherSummary}
WEATHER ANALYSIS: ${weatherAnalysis}

Provide a comprehensive analysis with ratings (1-10) for each category.
Consider how the player's specific SG strengths/weaknesses match THIS course's demands.

Return ONLY valid JSON (no markdown, no backticks):
{
  "overallRating": 7,
  "verdict": "LEAN YES",
  "summary": "2-3 sentence overall assessment combining all factors",
  "courseFit": {
    "rating": 7,
    "analysis": "How their SG profile matches course demands. Be specific about which stats matter here and how the player compares."
  },
  "recentForm": {
    "rating": 6,
    "analysis": "Assessment of current form, consistency, and momentum based on their ranking and SG trends."
  },
  "oddsValue": {
    "rating": 5,
    "analysis": "Are the odds fair, too short, or do they offer value? Compare implied probability to your assessment."
  },
  "weatherImpact": {
    "rating": 7,
    "analysis": "How forecast conditions affect this specific player's game. Wind, rain, temperature factors."
  },
  "keyStrength": "One sentence about their biggest advantage this week",
  "keyWeakness": "One sentence about their biggest concern this week"
}

VERDICT must be one of: STRONG BET, LEAN YES, NEUTRAL, LEAN AVOID, AVOID
Rating scale: 1-3 = poor, 4-5 = below average, 6 = average, 7 = good, 8-9 = very good, 10 = exceptional`;

    console.log('[PLAYER] Calling Claude API...');
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0].text;
    let analysis;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (parseError) {
      console.error('[PLAYER] Parse failed:', responseText.substring(0, 200));
      throw new Error('Invalid AI response format');
    }

    const cost = calculateClaudeCost(message.usage);
    console.log(`[PLAYER] ✅ ${analysis.verdict} (${analysis.overallRating}/10)`);

    return createResponse(200, {
      player: playerName,
      tournament: {
        name: tournament.name,
        course: tournament.course,
        location: tournament.location,
        dates: tournament.dates
      },
      stats,
      odds: playerOdds ? {
        odds: playerOdds.odds,
        minOdds: playerOdds.minOdds,
        maxOdds: playerOdds.maxOdds,
        bookmakerCount: playerOdds.bookmakerCount
      } : null,
      weather: weatherSummary,
      analysis,
      generatedAt: new Date().toISOString(),
      tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      estimatedCost: cost
    });

  } catch (error) {
    console.error('[PLAYER] Error:', error.message);
    return createResponse(500, {
      error: 'Failed to analyze player',
      message: error.message
    });
  }
};

function createResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}
