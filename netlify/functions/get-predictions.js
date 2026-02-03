const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { getStore } = require('@netlify/blobs');

/**
 * Main prediction endpoint - OPTIMIZED VERSION
 * Fetches data in parallel where possible and reduces logging overhead
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const reqId = event.queryStringParameters?.reqId || 'unknown';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[START] Predictions for ${tour.toUpperCase()} tour - Request ID: ${reqId}`);

    // Step 1: Try to get cached player data
    const cacheKey = `player-data-${tour}`;
    let playersWithData = null;
    let tournament = null;
    let weatherData = null;
    let courseInfo = null;
    
    try {
      const { getStore } = require('@netlify/blobs');
      const siteID = process.env.SITE_ID;
      const token = process.env.NETLIFY_AUTH_TOKEN;
      
      if (siteID && token) {
        const store = getStore({
          name: 'cache',
          siteID: siteID,
          token: token,
          consistency: 'strong'
        });
        
        const cached = await store.get(cacheKey, { type: 'json' });
        
        if (cached && cached.timestamp) {
          const cacheAge = Date.now() - cached.timestamp;
          const sixHours = 6 * 60 * 60 * 1000;
          
          if (cacheAge < sixHours) {
            console.log(`[CACHE] Using cached player data (${Math.round(cacheAge / 1000 / 60)} minutes old)`);
            playersWithData = cached.players;
            tournament = cached.tournament;
            weatherData = cached.weather;
            courseInfo = cached.courseInfo;
          } else {
            console.log(`[CACHE] Cache expired (${Math.round(cacheAge / 1000 / 60 / 60)} hours old), fetching fresh data`);
          }
        } else {
          console.log(`[CACHE] No cache found, fetching fresh data`);
        }
      }
    } catch (cacheError) {
      console.log(`[CACHE] Error reading cache: ${cacheError.message}`);
    }

    // Step 2: If no valid cache, fetch all data
    if (!playersWithData) {
      console.log(`[FETCH] Fetching fresh player data...`);

      // Step 2a: Fetch tournament data
      const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
        timeout: 15000
      });
      tournament = tournamentResponse.data;

      if (!tournament?.field?.length) {
        throw new Error('No tournament field data available');
      }

      console.log(`[TOURNAMENT] ${tournament.name} (${tournament.field.length} players)`);

      const playerNames = tournament.field.map(p => p.name);

      // Step 2b-2e: Fetch stats, odds, weather, and course info IN PARALLEL
      const [statsResponse, oddsResponse, weatherResponse, courseInfoResponse, recentFormData] = await Promise.all([
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
        ).then(r => r.data),
        // Recent form and course history
        fetchRecentFormAndHistory(playerNames, tournament.course, tour)
      ]);

      const statsData = statsResponse.data;
      const oddsData = oddsResponse.data;
      weatherData = weatherResponse;
      courseInfo = courseInfoResponse;

      console.log(`[DATA] Stats: ${statsData.players.length}, Odds: ${oddsData.odds.length}, Course: ${courseInfo.courseName || courseInfo.eventName}, Form data: ${recentFormData.players.length}`);
      
      // Check odds distribution to see if we have favorites
      if (oddsData.odds.length > 0) {
        const oddsValues = oddsData.odds.map(p => p.odds).sort((a, b) => a - b);
        const lowestOdds = oddsValues.slice(0, 5);
        console.log(`[ODDS] Top 5 lowest odds (American): ${lowestOdds.map(o => formatAmericanOdds(o)).join(', ')}`);
        
        // Count favorites: American odds under +1900 (equivalent to 20.0 decimal)
        const favoritesCount = oddsValues.filter(o => o < 1900).length;
        console.log(`[ODDS] Players with odds under +1900 (favorites): ${favoritesCount}`);
      }

      // Step 2f: Merge player data (stats + odds + form)
      playersWithData = mergePlayerData(statsData.players, oddsData.odds, recentFormData.players);

      console.log(`[MERGE] ${playersWithData.length} players with complete data`);
      
      // Step 2g: Save to cache
      try {
        const { getStore } = require('@netlify/blobs');
        const siteID = process.env.SITE_ID;
        const token = process.env.NETLIFY_AUTH_TOKEN;
        
        if (siteID && token) {
          const store = getStore({
            name: 'cache',
            siteID: siteID,
            token: token,
            consistency: 'strong'
          });
          
          await store.set(cacheKey, JSON.stringify({
            timestamp: Date.now(),
            players: playersWithData,
            tournament: tournament,
            weather: weatherData,
            courseInfo: courseInfo
          }));
          
          console.log(`[CACHE] ✅ Saved fresh data to cache`);
        }
      } catch (cacheError) {
        console.log(`[CACHE] ⚠️  Failed to save cache: ${cacheError.message}`);
      }
    }

    // Step 3: Select top 60 players by odds (lower odds = higher ranked)
    // Optimized for speed - must complete under 25 seconds to avoid Netlify timeout
    const topPlayers = playersWithData
      .sort((a, b) => a.odds - b.odds)
      .slice(0, 60);
    
    console.log(`[CLAUDE] Analyzing top ${topPlayers.length} players (optimized from ${playersWithData.length})`);

    // Step 4: Call Claude API
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildClaudePrompt(tournament, topPlayers, weatherData.summary, courseInfo);

    let message, predictions;
    try {
      const claudeStartTime = Date.now();
      console.log(`[CLAUDE] Sending request to Claude API...`);
      message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,  // Reduced from 2500 - need to finish under 25s
        temperature: 0.5,  // Higher for faster generation
        messages: [{ role: 'user', content: prompt }]
      });
      const claudeDuration = ((Date.now() - claudeStartTime) / 1000).toFixed(1);
      console.log(`[CLAUDE] ✅ Received response from Claude API (took ${claudeDuration}s)`);
    } catch (claudeError) {
      console.error(`[CLAUDE] ❌ API call failed:`, claudeError.message);
      throw new Error(`Claude API error: ${claudeError.message}`);
    }

    // Step 5: Parse Claude response
    try {
      predictions = parseClaudeResponse(message.content[0].text);
      console.log(`[CLAUDE] Generated ${predictions.picks?.length || 0} picks`);
    } catch (parseError) {
      console.error(`[CLAUDE] ❌ Failed to parse response:`, parseError.message);
      throw new Error(`Failed to parse Claude response: ${parseError.message}`);
    }
    
    // Step 6: Validate and FIX pick distribution (1 favorite + 5 value)
    try {
      if (predictions.picks && predictions.picks.length === 6) {
        const firstPickOdds = predictions.picks[0].odds;
        const remainingOdds = predictions.picks.slice(1).map(p => p.odds);
        
        console.log(`[VALIDATION] Pick #1 odds: ${formatAmericanOdds(firstPickOdds)} (should be under +1900)`);
        console.log(`[VALIDATION] Picks #2-6 odds: ${remainingOdds.map(o => formatAmericanOdds(o)).join(', ')} (should all be +1900 or higher)`);
        
        // Find the pick with lowest odds
        let lowestOddsIndex = 0;
        let lowestOdds = predictions.picks[0].odds;
        
        for (let i = 1; i < predictions.picks.length; i++) {
          if (predictions.picks[i].odds < lowestOdds) {
            lowestOdds = predictions.picks[i].odds;
            lowestOddsIndex = i;
          }
        }
        
        // If first pick is not the lowest, reorder
        if (lowestOddsIndex !== 0) {
          console.warn(`[VALIDATION] ⚠️  Pick #1 odds (${formatAmericanOdds(firstPickOdds)}) is NOT lowest! Auto-fixing by reordering...`);
          const lowestPick = predictions.picks[lowestOddsIndex];
          predictions.picks.splice(lowestOddsIndex, 1);
          predictions.picks.unshift(lowestPick);
          console.log(`[VALIDATION] ✅ Fixed! Moved ${lowestPick.player} (${formatAmericanOdds(lowestPick.odds)}) to Pick #1`);
        }
        
        // Check if we even have any favorites (odds under +1900)
        if (lowestOdds >= 1900) {
          console.warn(`[VALIDATION] ⚠️  NO players with odds under +1900 in this field! Lowest is ${formatAmericanOdds(lowestOdds)}`);
          console.log(`[VALIDATION] Using ${predictions.picks[0].player} at ${formatAmericanOdds(predictions.picks[0].odds)} as "favorite" (best available)`);
        }
      }
    } catch (validationError) {
      console.error(`[VALIDATION] ❌ Error during validation:`, validationError.message);
      // Continue anyway - validation is not critical
    }

    // Step 7: Enrich predictions with odds breakdown
    try {
      enrichPredictionsWithOdds(predictions, topPlayers);
      console.log(`[ENRICH] ✅ Added odds breakdown to predictions`);
    } catch (enrichError) {
      console.error(`[ENRICH] ❌ Failed to enrich predictions:`, enrichError.message);
      // Continue anyway - enrichment is not critical
    }

    // Step 8: Calculate costs
    const cost = calculateCost(message.usage);

    const generatedAt = new Date().toISOString();
    const responseData = {
      tournament: {
        name: tournament.name,
        course: tournament.course,
        location: tournament.location,
        dates: tournament.dates,
        tour: tournament.tour,
        eventId: tournament.eventId
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
      generatedAt,
      tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      tokenBreakdown: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens
      },
      estimatedCost: cost
    };

    // Step 9: Save predictions to Netlify Blobs for results tracking
    try {
      console.log('[SAVE] Attempting to save to Netlify Blobs...');
      console.log('[SAVE] Environment check:', {
        hasDeployId: !!process.env.DEPLOY_ID,
        hasSiteId: !!process.env.SITE_ID,
        hasContext: !!process.env.CONTEXT,
        nodeVersion: process.version
      });
      
      await savePredictionsToBlobs(responseData);
      console.log('[SAVE] ✅ Predictions saved for results tracking');
    } catch (saveError) {
      console.error('[SAVE] Failed to save predictions:', saveError.message);
      console.error('[SAVE] Error stack:', saveError.stack);
      console.log('[SAVE] This is not critical - predictions still returned successfully');
      // Don't fail the request if save fails
    }

    // Step 12: Return response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify(responseData)
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
 * Fetch recent form and course history for players
 */
async function fetchRecentFormAndHistory(playerNames, courseName, tour) {
  const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
  const apiTour = tour === 'dp' ? 'euro' : (tour || 'pga');
  
  try {
    console.log(`[FORM] Fetching recent tournament results...`);
    
    // Fetch schedule to get recent tournaments
    const scheduleUrl = `https://feeds.datagolf.com/get-schedule?tour=${apiTour}&file_format=json&key=${apiKey}`;
    const scheduleResponse = await axios.get(scheduleUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    const tournaments = Array.isArray(scheduleResponse.data.schedule) 
      ? scheduleResponse.data.schedule 
      : Object.values(scheduleResponse.data.schedule);

    console.log(`[FORM] Fetched ${tournaments.length} tournaments from schedule`);
    
    // Log a sample to see the structure
    if (tournaments.length > 0) {
      const sample = tournaments[0];
      console.log(`[FORM] Sample tournament structure:`, JSON.stringify({
        event_name: sample.event_name,
        event_completed: sample.event_completed,
        date: sample.date,
        start_date: sample.start_date,
        end_date: sample.end_date
      }));
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Get completed tournaments (where end_date or start_date is in the past)
    const completedTournaments = tournaments
      .filter(t => {
        // Try different date fields
        const endDate = t.end_date || t.date || t.start_date;
        if (!endDate) return false;
        
        // Parse date and check if it's in the past (tournament finished at least 3 days ago)
        const tourneyDate = new Date(endDate);
        const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        
        const isCompleted = tourneyDate < threeDaysAgo;
        
        if (tournaments.indexOf(t) < 5) {
          console.log(`[FORM] Tournament "${t.event_name}" - date: ${endDate}, completed: ${isCompleted}`);
        }
        
        return isCompleted;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);

    console.log(`[FORM] Found ${completedTournaments.length} recent completed tournaments`);

    // For each player, compile their recent results
    const playerFormData = {};
    
    for (const player of playerNames) {
      playerFormData[normalizePlayerName(player)] = {
        recentResults: [],
        courseHistory: [],
        momentum: 'unknown'
      };
    }

    // Fetch results for recent tournaments
    for (const tournament of completedTournaments.slice(0, 5)) {
      try {
        const fieldUrl = `https://feeds.datagolf.com/field-updates?tour=${apiTour}&file_format=json&key=${apiKey}`;
        const fieldResponse = await axios.get(fieldUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Golf-Predictor-App/1.0',
            'Accept': 'application/json'
          }
        });

        if (fieldResponse.data?.field) {
          const isCourseMatch = tournament.course?.toLowerCase().includes(courseName?.toLowerCase().split(' ')[0]) ||
                                courseName?.toLowerCase().includes(tournament.course?.toLowerCase().split(' ')[0]);

          for (const playerResult of fieldResponse.data.field) {
            if (!playerResult.player_name) continue;
            
            const normalizedName = normalizePlayerName(playerResult.player_name);
            if (playerFormData[normalizedName]) {
              const result = {
                tournament: tournament.event_name,
                date: tournament.date,
                position: playerResult.finish_position || playerResult.position,
                score: playerResult.total_to_par,
                madeCut: playerResult.made_cut !== false
              };

              // Add to recent results
              playerFormData[normalizedName].recentResults.push(result);

              // If this is the same course, add to course history
              if (isCourseMatch) {
                playerFormData[normalizedName].courseHistory.push(result);
              }
            }
          }
        }
      } catch (error) {
        console.log(`[FORM] Failed to fetch results for ${tournament.event_name}:`, error.message);
      }
    }

    // Calculate momentum for each player
    for (const normalizedName in playerFormData) {
      const recent = playerFormData[normalizedName].recentResults;
      if (recent.length >= 3) {
        // Get average position from first 3 vs last 3 results
        const recentPositions = recent.slice(0, 3).map(r => parseInt(r.position) || 999);
        const olderPositions = recent.slice(3, 6).map(r => parseInt(r.position) || 999);
        
        if (recentPositions.length > 0 && olderPositions.length > 0) {
          const recentAvg = recentPositions.reduce((a, b) => a + b, 0) / recentPositions.length;
          const olderAvg = olderPositions.reduce((a, b) => a + b, 0) / olderPositions.length;
          
          if (recentAvg < olderAvg - 10) {
            playerFormData[normalizedName].momentum = '📈 Hot (improving)';
          } else if (recentAvg > olderAvg + 10) {
            playerFormData[normalizedName].momentum = '📉 Cold (declining)';
          } else {
            playerFormData[normalizedName].momentum = '➡️ Steady';
          }
        }
      }
    }

    console.log(`[FORM] ✅ Compiled form data for ${Object.keys(playerFormData).length} players`);

    return {
      players: Object.keys(playerFormData).map(normalizedName => ({
        normalizedName,
        ...playerFormData[normalizedName]
      }))
    };

  } catch (error) {
    console.error('[FORM] Failed to fetch form data:', error.message);
    return { players: [] };
  }
}

/**
 * Merge stats and odds data for all players
 */
function mergePlayerData(statsPlayers, oddsPlayers, formPlayers = []) {
  return statsPlayers
    .map(stat => {
      const oddsEntry = oddsPlayers.find(o => 
        normalizePlayerName(o.player) === normalizePlayerName(stat.player)
      );
      
      if (!oddsEntry) return null;

      // Keep American odds format (e.g., +225, -110)
      const americanOdds = oddsEntry.odds; // Already in American format from API
      
      // Find form data for this player
      const formData = formPlayers.find(f => 
        f.normalizedName === normalizePlayerName(stat.player)
      );
      
      return {
        name: stat.player,
        rank: stat.stats.rank,
        odds: americanOdds,  // American odds (e.g., +225)
        americanOdds: formatAmericanOdds(americanOdds), // Formatted string (e.g., "+225")
        minOdds: oddsEntry.minOdds,
        maxOdds: oddsEntry.maxOdds,
        bestBookmaker: oddsEntry.bestBookmaker,
        worstBookmaker: oddsEntry.worstBookmaker,
        bookmakerCount: oddsEntry.bookmakerCount,
        sgTotal: stat.stats.sgTotal,
        sgOTT: stat.stats.sgOTT,
        sgAPP: stat.stats.sgAPP,
        sgARG: stat.stats.sgARG,
        sgPutt: stat.stats.sgPutt,
        // Recent form
        recentResults: formData?.recentResults || [],
        courseHistory: formData?.courseHistory || [],
        momentum: formData?.momentum || 'Unknown'
      };
    })
    .filter(p => p !== null)
    .sort((a, b) => a.odds - b.odds); // Lower American odds come first (e.g., +200 before +500)
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
 * Format American odds with + sign
 */
function formatAmericanOdds(odds) {
  if (!odds || odds === 0) return 'N/A';
  return odds > 0 ? `+${odds}` : `${odds}`;
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
 * Build enhanced prompt for Claude with weather analysis
 */
function buildClaudePrompt(tournament, players, weatherSummary, courseInfo) {
  // ========================================
  // 🎯 WEIGHTING CONFIGURATION - EDIT HERE
  // ========================================
  const WEIGHTS = {
    courseFit: 40,           // % - How well stats match course demands
    recentForm: 15,          // % - Last 5 tournaments performance
    courseHistory: 20,       // % - Past results at this venue (0% if no history)
    weather: 15,             // % - Weather adaptation
    statisticalQuality: 10   // % - Overall player quality check
  };
  
  // When player has NO course history, redistribute weight:
  const WEIGHTS_NO_HISTORY = {
    courseFit: 50,           // Increased importance
    recentForm: 20,          // Increased importance
    weather: 15,             // Same
    statisticalQuality: 15   // Increased importance
  };
  // ========================================
  
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  // Analyze weather conditions
  const weatherAnalysis = analyzeWeatherConditions(weatherSummary);

  // Determine primary course demands based on characteristics
  const courseDemands = analyzeCourseSkillDemands(courseInfo);

  // Format player lists
  const formatPlayerList = (playerList) => playerList
    .map(p => {
      let formStr = '';
      
      // Recent results (last 5)
      if (p.recentResults?.length > 0) {
        const results = p.recentResults.slice(0, 5).map(r => 
          `${r.position || 'MC'}${r.madeCut ? '' : '(MC)'}`
        ).join(',');
        formStr += ` | Last5: ${results}`;
      }
      
      // Course history
      if (p.courseHistory?.length > 0) {
        const courseResults = p.courseHistory.map(r => 
          `${r.position || 'MC'}${r.madeCut ? '' : '(MC)'}`
        ).join(',');
        formStr += ` | ThisCourse: ${courseResults}`;
      }
      
      // Momentum
      if (p.momentum && p.momentum !== 'Unknown') {
        formStr += ` | ${p.momentum}`;
      }
      
      // Use American odds format
      return `${p.name} [${formatAmericanOdds(p.odds)}] - R${p.rank||'?'} | SG:${p.sgTotal?.toFixed(2)} (OTT:${p.sgOTT?.toFixed(2)} APP:${p.sgAPP?.toFixed(2)} ARG:${p.sgARG?.toFixed(2)} P:${p.sgPutt?.toFixed(2)})${formStr}`;
    })
    .join('\n');

  return `Golf analyst: Find 6 VALUE picks (1 favorite <+1900, 5 value picks +1900+).

TOURNAMENT: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName} | ${courseInfo.yardage || '?'}y Par ${courseInfo.par || '?'}
Demands: ${courseDemands}
Weather: ${weatherAnalysis}

PLAYERS (all 60 by odds):
${formatPlayerList(players)}

ANALYSIS FRAMEWORK:
1. Course Fit (40%): Match SG stats to demands above
2. Course History (20%): Past results here (or explain why no history OK if empty)
3. Recent Form (15%): Last5 finishes + momentum (📈 Hot / 📉 Cold)
4. Weather (15%): How conditions favor their game
5. Statistical Quality (10%): Overall SG quality check

PICK REQUIREMENTS:
- Pick #1: MUST be <+1900 (choose best VALUE favorite, NOT just lowest odds)
- Picks #2-6: MUST be +1900+ (at least 3 picks should be +4000+)

EXAMPLES:
✅ GOOD FAVORITE: "Morikawa [+1400] - Elite APP matches precision course + won here before"
❌ BAD FAVORITE: "Scheffler [+220] - Yes he's #1 but poor course history + weak fit = no value"

✅ VALUE WITH HISTORY: "Player X [+4500] - Strong fit + T5/T12 history here + hot form"
✅ VALUE NO HISTORY: "Player Z [+5500] - PERFECT SG match for demands + consistent Top 15s"

REASONING FORMAT (2-3 sentences each):
"Course fit: [specific SG match]. History: [results or why OK without]. Form: [Last5 + momentum]. Weather: [impact]. Value: [why odds too high]."

🚨 VALIDATE BEFORE RETURNING:
- Pick #1 odds < +1900? If not, choose different favorite
- Picks #2-6 all +1900+? If not, choose different players
- At least 3 picks +4000+? If not, add more longshots

Return ONLY JSON:
{
  "courseType": "Brief course analysis (2-3 sentences)",
  "weatherImpact": "How weather affects play (2 sentences)",
  "keyFactors": ["Factor 1", "Factor 2", "Factor 3", "Factor 4"],
  "courseNotes": "Betting insights: which player types over/underpriced (2-3 sentences)",
  "picks": [
    {"player": "Name", "odds": 1400, "reasoning": "Course fit + history + form + weather + value"}
  ]
}`;
}

/**
 * Analyze weather conditions and provide specific player selection guidance
 */
function analyzeWeatherConditions(weatherSummary) {
  if (!weatherSummary || weatherSummary === 'Weather data not available') {
    return 'Weather data not available - focus purely on course characteristics and historical stats.';
  }

  // Parse weather summary to extract conditions
  const windSpeeds = [];
  const rainChances = [];
  let conditions = weatherSummary;

  // Extract wind speeds
  const windMatches = weatherSummary.match(/Wind:\s*(\d+)mph/g);
  if (windMatches) {
    windMatches.forEach(match => {
      const speed = parseInt(match.match(/\d+/)[0]);
      windSpeeds.push(speed);
    });
  }

  // Extract rain chances
  const rainMatches = weatherSummary.match(/Rain:\s*(\d+)%/g);
  if (rainMatches) {
    rainMatches.forEach(match => {
      const chance = parseInt(match.match(/\d+/)[0]);
      rainChances.push(chance);
    });
  }

  const avgWind = windSpeeds.length > 0 
    ? Math.round(windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length) 
    : 0;
  const maxWind = windSpeeds.length > 0 ? Math.max(...windSpeeds) : 0;
  const highRainDays = rainChances.filter(r => r > 50).length;
  const anyRainDays = rainChances.filter(r => r > 30).length;

  let analysis = [`Raw Conditions: ${conditions}`, ''];

  // Wind analysis
  if (maxWind >= 15) {
    analysis.push(`⚠️ HIGH WIND ALERT (${maxWind}mph max, ${avgWind}mph avg):`);
    analysis.push('- CRITICAL: Prioritize SG:OTT (ball flight control, trajectory management)');
    analysis.push('- Secondary: SG:APP (wind-adjusted approach shots)');
    analysis.push('- Deprioritize: SG:Putt (less important when scores are high)');
    analysis.push('- Look for: Players with positive SG:OTT who are undervalued');
  } else if (avgWind >= 10) {
    analysis.push(`💨 MODERATE WIND (${avgWind}mph avg):`);
    analysis.push('- Important: SG:OTT (trajectory control matters)');
    analysis.push('- Balanced approach: All SG categories relevant');
  } else {
    analysis.push(`😌 CALM CONDITIONS (${avgWind}mph avg):`);
    analysis.push('- CRITICAL: SG:Putt (low scores, putting wins)');
    analysis.push('- Secondary: SG:APP (hitting greens for birdie chances)');
    analysis.push('- Deprioritize: SG:OTT (length advantage reduced when conditions are easy)');
  }

  // Rain analysis
  if (highRainDays >= 2) {
    analysis.push('');
    analysis.push(`🌧️ WET CONDITIONS (${highRainDays} days with 50%+ rain):`);
    analysis.push('- CRITICAL: SG:OTT (length advantage on soft fairways/greens)');
    analysis.push('- Important: SG:APP (wedge play, soft greens hold shots)');
    analysis.push('- Consider: SG:ARG (soft conditions around greens)');
    analysis.push('- Deprioritize: SG:Putt (soft greens are easier to putt)');
  } else if (anyRainDays > 0) {
    analysis.push('');
    analysis.push(`🌦️ SOME RAIN POSSIBLE (${anyRainDays} days with 30%+ chance):`);
    analysis.push('- Slight advantage: Longer hitters (SG:OTT)');
    analysis.push('- Monitor: Conditions may soften as week progresses');
  }

  return analysis.join('\n');
}

/**
 * Analyze course characteristics to determine primary skill demands
 */
function analyzeCourseSkillDemands(courseInfo) {
  const demands = [];

  // Yardage analysis
  if (courseInfo.yardage) {
    if (courseInfo.yardage > 7500) {
      demands.push('1. SG:OTT (PRIMARY) - Extreme length demands elite driving distance and accuracy');
    } else if (courseInfo.yardage > 7300) {
      demands.push('1. SG:OTT (CRITICAL) - Long course heavily favors driving distance');
    } else if (courseInfo.yardage > 7100) {
      demands.push('1. SG:OTT (Important) - Above-average length requires solid driving');
    } else {
      demands.push('1. SG:APP + SG:ARG (PRIMARY) - Shorter course emphasizes precision over power');
    }
  }

  // Width analysis
  if (courseInfo.width) {
    const width = courseInfo.width.toLowerCase();
    if (width.includes('narrow') || width.includes('tight')) {
      demands.push('2. SG:APP (CRITICAL) - Narrow fairways require precision iron play and course management');
      demands.push('3. SG:ARG (Important) - Tight course means more scrambling opportunities');
    } else if (width.includes('wide') || width.includes('generous')) {
      demands.push('2. SG:OTT (Enhanced) - Wide fairways reward aggressive driving for distance');
      demands.push('3. SG:APP (Important) - Longer approaches from extra distance');
    }
  }

  // Rough analysis
  if (courseInfo.rough) {
    const rough = courseInfo.rough.toLowerCase();
    if (rough.includes('heavy') || rough.includes('thick') || rough.includes('penal')) {
      demands.push('4. SG:OTT (Accuracy) - Heavy rough severely punishes offline drives');
      demands.push('5. SG:ARG (Critical) - Recovery skills essential for scrambling');
    }
  }

  // Green analysis
  if (courseInfo.greens) {
    const greens = courseInfo.greens.toLowerCase();
    if (greens.includes('fast') || greens.includes('firm') || greens.includes('bentgrass')) {
      demands.push('6. SG:Putt (Enhanced) - Fast greens amplify putting skill differences');
    } else if (greens.includes('poa') || greens.includes('bumpy')) {
      demands.push('6. SG:APP (Critical) - Inconsistent greens demand precise approach distance control');
    }
  }

  // Difficulty analysis
  if (courseInfo.difficulty) {
    const difficulty = courseInfo.difficulty.toLowerCase();
    if (difficulty.includes('very difficult') || difficulty.includes('extremely')) {
      demands.push('7. SG:Total (Quality) - Difficult course requires well-rounded elite players');
    }
  }

  // Default if no specific demands identified
  if (demands.length === 0) {
    demands.push('1. SG:OTT (Important) - Driving quality sets up scoring opportunities');
    demands.push('2. SG:APP (Important) - Iron play for green-in-regulation');
    demands.push('3. SG:ARG (Moderate) - Short game for scrambling');
    demands.push('4. SG:Putt (Moderate) - Putting to convert scoring chances');
  }

  return demands.join('\n');
}

/**
 * Save predictions to Netlify Blobs for results tracking
 */
async function savePredictionsToBlobs(responseData) {
  // Manually configure store with siteID and token from environment
  const siteID = process.env.SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  
  if (!siteID || !token) {
    throw new Error('SITE_ID or NETLIFY_AUTH_TOKEN not configured. Please add NETLIFY_AUTH_TOKEN to your environment variables.');
  }
  
  const store = getStore({
    name: 'predictions',
    siteID: siteID,
    token: token,
    consistency: 'strong'
  });

  // Generate key from tournament name and date
  const tournamentSlug = responseData.tournament.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const date = new Date(responseData.generatedAt);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  
  const key = `${tournamentSlug}-${dateStr}`;

  // Prepare data to save (simplified version for tracking)
  const predictionData = {
    tournament: responseData.tournament,
    courseInfo: {
      par: responseData.courseInfo?.par,
      yardage: responseData.courseInfo?.yardage,
      difficulty: responseData.courseInfo?.difficulty
    },
    weather: responseData.weather,
    predictions: responseData.predictions.map(pick => ({
      player: pick.player,
      odds: pick.odds,
      minOdds: pick.minOdds,
      maxOdds: pick.maxOdds,
      bestBookmaker: pick.bestBookmaker,
      reasoning: pick.reasoning
    })),
    metadata: {
      generatedAt: responseData.generatedAt,
      savedAt: new Date().toISOString(),
      pickCount: responseData.predictions.length,
      status: 'pending'
    }
  };

  await store.set(key, JSON.stringify(predictionData));
  console.log(`[SAVE] Saved to blob: ${key}`);
}
