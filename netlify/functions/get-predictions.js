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
    const [statsResponse, oddsResponse, weatherData, courseInfo, recentFormData] = await Promise.all([
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

    console.log(`[DATA] Stats: ${statsData.players.length}, Odds: ${oddsData.odds.length}, Course: ${courseInfo.courseName || courseInfo.eventName}, Form data: ${recentFormData.players.length}`);

    // Step 5: Merge player data (stats + odds + form)
    const playersWithData = mergePlayerData(statsData.players, oddsData.odds, recentFormData.players);

    console.log(`[MERGE] ${playersWithData.length} players with complete data`);

    // Step 6: Select top 80 players by odds (lower odds = higher ranked)
    // This reduces prompt size and speeds up Claude analysis significantly
    const topPlayers = playersWithData
      .sort((a, b) => a.odds - b.odds)
      .slice(0, 80);
    
    console.log(`[CLAUDE] Analyzing top ${topPlayers.length} players (reduced from ${playersWithData.length} for speed)`);

    // Step 7: Call Claude API
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildClaudePrompt(tournament, topPlayers, weatherData.summary, courseInfo);

    let message, predictions;
    try {
      const claudeStartTime = Date.now();
      console.log(`[CLAUDE] Sending request to Claude API...`);
      message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,  // Reduced from 4000 - predictions don't need that many tokens
        temperature: 0.4,  // Slightly higher for faster generation (was 0.3)
        messages: [{ role: 'user', content: prompt }]
      });
      const claudeDuration = ((Date.now() - claudeStartTime) / 1000).toFixed(1);
      console.log(`[CLAUDE] ✅ Received response from Claude API (took ${claudeDuration}s)`);
    } catch (claudeError) {
      console.error(`[CLAUDE] ❌ API call failed:`, claudeError.message);
      throw new Error(`Claude API error: ${claudeError.message}`);
    }

    // Step 8: Parse Claude response
    try {
      predictions = parseClaudeResponse(message.content[0].text);
      console.log(`[CLAUDE] Generated ${predictions.picks?.length || 0} picks`);
    } catch (parseError) {
      console.error(`[CLAUDE] ❌ Failed to parse response:`, parseError.message);
      throw new Error(`Failed to parse Claude response: ${parseError.message}`);
    }
    
    // Step 8.5: Validate and FIX pick distribution (1 favorite + 5 value)
    try {
      if (predictions.picks && predictions.picks.length === 6) {
        const firstPickOdds = predictions.picks[0].odds;
        const remainingOdds = predictions.picks.slice(1).map(p => p.odds);
        
        console.log(`[VALIDATION] Pick #1 odds: ${firstPickOdds} (should be < 20)`);
        console.log(`[VALIDATION] Picks #2-6 odds: ${remainingOdds.join(', ')} (should all be >= 20)`);
        
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
          console.warn(`[VALIDATION] ⚠️  Pick #1 odds (${firstPickOdds}) is NOT lowest! Auto-fixing by reordering...`);
          const lowestPick = predictions.picks[lowestOddsIndex];
          predictions.picks.splice(lowestOddsIndex, 1);
          predictions.picks.unshift(lowestPick);
          console.log(`[VALIDATION] ✅ Fixed! Moved ${lowestPick.player} (${lowestPick.odds}) to Pick #1`);
        }
        
        // Check if we even have any favorites (odds < 20)
        if (lowestOdds >= 20) {
          console.warn(`[VALIDATION] ⚠️  NO players with odds < 20 in this field! Lowest is ${lowestOdds}`);
          console.log(`[VALIDATION] Using ${predictions.picks[0].player} at ${predictions.picks[0].odds} as "favorite" (best available)`);
        }
      }
    } catch (validationError) {
      console.error(`[VALIDATION] ❌ Error during validation:`, validationError.message);
      // Continue anyway - validation is not critical
    }

    // Step 9: Enrich predictions with odds breakdown
    try {
      enrichPredictionsWithOdds(predictions, topPlayers);
      console.log(`[ENRICH] ✅ Added odds breakdown to predictions`);
    } catch (enrichError) {
      console.error(`[ENRICH] ❌ Failed to enrich predictions:`, enrichError.message);
      // Continue anyway - enrichment is not critical
    }

    // Step 10: Calculate costs
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

    // Step 11: Save predictions to Netlify Blobs for results tracking
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

    // Get last 10 completed tournaments
    const completedTournaments = tournaments
      .filter(t => {
        const isCompleted = t.event_completed === true;
        if (!isCompleted && tournaments.indexOf(t) < 5) {
          console.log(`[FORM] Tournament "${t.event_name}" - event_completed: ${t.event_completed}`);
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

      const decimalOdds = americanToDecimal(oddsEntry.odds);
      
      // Find form data for this player
      const formData = formPlayers.find(f => 
        f.normalizedName === normalizePlayerName(stat.player)
      );
      
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
        sgPutt: stat.stats.sgPutt,
        // Recent form
        recentResults: formData?.recentResults || [],
        courseHistory: formData?.courseHistory || [],
        momentum: formData?.momentum || 'Unknown'
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
      
      return `${p.name} [${p.odds?.toFixed(1)}] - R${p.rank||'?'} | SG:${p.sgTotal?.toFixed(2)} (OTT:${p.sgOTT?.toFixed(2)} APP:${p.sgAPP?.toFixed(2)} ARG:${p.sgARG?.toFixed(2)} P:${p.sgPutt?.toFixed(2)})${formStr}`;
    })
    .join('\n');

  return `You are a professional golf analyst specializing in finding VALUE picks based on course fit and conditions, NOT favorites.

TOURNAMENT: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName}
Location: ${courseInfo.location}${courseInfo.city ? ` (${courseInfo.city}${courseInfo.state ? ', ' + courseInfo.state : ''})` : ''}

COURSE PROFILE:
${courseInfo.par ? `Par: ${courseInfo.par}` : 'Par: Unknown'}
${courseInfo.yardage ? `Yardage: ${courseInfo.yardage} yards (${courseInfo.yardage > 7400 ? 'LONG - Distance critical' : courseInfo.yardage > 7200 ? 'Above Average Length' : 'Standard Length'})` : 'Yardage: Unknown'}
${courseInfo.avgScore && courseInfo.par ? `Scoring: ${courseInfo.avgScore} avg (${(courseInfo.avgScore - courseInfo.par) > 0 ? '+' : ''}${(courseInfo.avgScore - courseInfo.par).toFixed(1)} vs par) - ${courseInfo.avgScore - courseInfo.par > 1 ? 'DIFFICULT' : courseInfo.avgScore - courseInfo.par > 0.5 ? 'Challenging' : 'Scorable'}` : ''}
Fairways: ${courseInfo.width || 'Unknown'}
Greens: ${courseInfo.greens || 'Unknown'}
Rough: ${courseInfo.rough || 'Unknown'}
${courseInfo.difficulty ? `Difficulty Rating: ${courseInfo.difficulty}` : ''}
${courseInfo.keyFeatures?.length ? `Key Features: ${courseInfo.keyFeatures.join(', ')}` : ''}

PRIMARY SKILL DEMANDS (prioritize these SG categories):
${courseDemands}

WEATHER CONDITIONS & IMPACT:
${weatherAnalysis}

COMPLETE FIELD (${players.length} players analyzed):

🚫 TOP FAVORITES (odds 5-20) - SKIP THESE - NO VALUE:
${formatPlayerList(favorites)}

💎 VALUE ZONE (odds 20-100) - PRIMARY FOCUS - MOST PICKS HERE:
${formatPlayerList(midTier)}

🎯 LONGSHOTS (odds 100+) - SELECT 1-2 ONLY IF EXCEPTIONAL COURSE FIT:
${formatPlayerList(longshots)}

YOUR TASK - MULTI-FACTOR ANALYSIS:
**🚨 CRITICAL: Select EXACTLY 6 picks with this MANDATORY distribution: 🚨**
- **Pick #1: ONE FAVORITE (odds UNDER 20/1)** - The BEST favorite from entire field
- **Picks #2-6: FIVE VALUE PICKS (odds 20/1 OR HIGHER)** - Best value from entire field

**⚠️  THIS IS ABSOLUTELY NON-NEGOTIABLE:**
- First pick MUST have odds < 20.0 (e.g., 3.2, 8.5, 12.0, 18.5)
- Remaining 5 picks MUST have odds >= 20.0 (e.g., 25.0, 45.0, 65.0, 85.0)
- If you cannot find a favorite with good value, pick the BEST available under 20/1
- DO NOT make all 6 picks from value zone (20/1+)

Use this decision framework:

1. COURSE FIT (Most Important - ${WEIGHTS.courseFit}% weight):
   - Match SG stats to PRIMARY SKILL DEMANDS listed above
   - Players MUST show strength in the course's key statistical categories
   - Example: Long course → prioritize high SG:OTT players
   - Example: Tight course → prioritize SG:APP and SG:ARG over SG:OTT

2. RECENT FORM & MOMENTUM (Important - ${WEIGHTS.recentForm}% weight):
   - "Last5" shows last 5 tournament finishes (lower = better, MC = missed cut)
   - Look for players with Top 20 finishes in recent events
   - Prioritize players with 📈 Hot (improving) momentum
   - AVOID players with 📉 Cold (declining) momentum
   - Recent good form (T5, T10, T15) indicates confidence and sharp game
   
3. COURSE HISTORY (Important - ${WEIGHTS.courseHistory}% weight):
   - "ThisCourse" shows past results at THIS specific venue
   - Players with Top 10 finishes at this course have PROVEN track record
   - **IMPORTANT: Many players have NO course history (empty "ThisCourse")**
   - **If ThisCourse is empty: Redistribute weight → ${WEIGHTS_NO_HISTORY.courseFit}% Course Fit, ${WEIGHTS_NO_HISTORY.recentForm}% Recent Form, ${WEIGHTS_NO_HISTORY.weather}% Weather**
   - **Players WITHOUT history CAN still be great picks if:**
     - Their SG stats are PERFECT match for course demands (strong course fit)
     - They have excellent recent form (multiple Top 20s in Last5)
     - Similar course types where they've succeeded
   - **With good history: Major bonus - prioritize these players**
   - **With bad history (MC, T65+): Requires exceptional odds to overcome**

4. WEATHER ADAPTATION (Important - ${WEIGHTS.weather}% weight):
   - Apply weather impact analysis from above
   - Wind → favor SG:OTT (ball flight control)
   - Wet conditions → favor length (SG:OTT) and wedge play (SG:APP)
   - Calm conditions → favor putting (SG:Putt becomes critical)

5. ODDS DISTRIBUTION (MANDATORY):
   **PICK #1 - THE FAVORITE:**
   - MUST be UNDER 20/1 (from the FAVORITES section)
   - **CRITICAL: Choose the favorite with BEST VALUE, NOT just lowest odds!**
   - A favorite at 12/1 with perfect fit is better than 3/1 with weak fit
   - Evaluate favorites using THE SAME criteria as value picks:
     * Course fit (40%) - Do their SG stats PERFECTLY match course demands?
     * Course history (20%) - Have they won/finished Top 5 here before?
     * Recent form (15%) - Are they playing well NOW (not just ranked #1)?
     * Weather (15%) - Do conditions favor their game?
   - **Example:** Scheffler at 3/1 with mediocre course fit = SKIP
   - **Example:** Morikawa at 14/1 with elite APP stats on precision course = PICK
   
   **PICKS #2-6 - VALUE ZONE:**
   - ALL 5 must be 20/1 OR HIGHER
   - At least 3 picks MUST be 40/1 or higher
   - Target distribution: 2 picks at 20-40/1, 2-3 picks at 40-80/1, 0-1 pick at 80-150/1

6. STATISTICAL QUALITY (${WEIGHTS.statisticalQuality}% - Quality Check):
   - Prefer positive SG:Total (indicates above-average player)
   - Look for "unbalanced" players (one great SG stat that matches course needs)
   - Example: Player with +1.2 SG:OTT but only +0.2 SG:Putt might be undervalued on long course

EXAMPLES:

✅ PICK #1 - THE FAVORITE (UNDER 20/1) - VALUE-BASED SELECTION:

GOOD FAVORITE (Not lowest odds, but BEST VALUE):
"Collin Morikawa [14.0] - R5 | SG:2.45 (OTT:0.45 APP:1.65 ARG:0.25 P:0.10) | Last5: T3,T8,2,T12,T5 | ThisCourse: 1,T4 | 📈 Hot"
→ At 14/1, elite APP stats PERFECTLY match this precision course + won here before + hot form = BEST VALUE FAVORITE

BAD FAVORITE (Lowest odds, but POOR VALUE):
"Scottie Scheffler [3.2] - R1 | SG:3.10 (OTT:0.93 APP:1.30) | Last5: 1,T2,T5 | ThisCourse: T45,MC | ➡️ Steady"
→ At 3/1, yes he's #1 in world but bad course history + course doesn't suit his strengths = POOR VALUE, SKIP

The favorite pick should be the one where odds are MOST WRONG relative to their fit, NOT just the tournament favorite!

✅ PICKS #2-6 - VALUE PICKS (20/1+):

VALUE PICK WITH COURSE HISTORY:
"Player X [45.0] - R12 | SG:1.85 (OTT:0.95 APP:0.72) | Last5: T8,T15,T22,MC,T18 | ThisCourse: T5,T12 | 📈 Hot"
→ Perfect: Strong course fit + hot form + proven course success

VALUE PICK WITHOUT COURSE HISTORY:
"Player Z [55.0] - R18 | SG:1.92 (OTT:1.15 APP:0.68) | Last5: T5,T12,T8,T15,T10 | ThisCourse: | ➡️ Steady"
→ Excellent pick despite no history: Elite course fit stats + consistent Top 15 form + good value odds

❌ BAD PICK:
"Player Y [65.0] - R45 | SG:0.45 (OTT:-0.15 APP:0.25) | Last5: MC,T45,MC,T52,MC | ThisCourse: MC,T65 | 📉 Cold"
→ Poor course fit + terrible form + bad course history = avoid

REASONING REQUIREMENTS:
For each pick, explain IN THIS ORDER:
1. **COURSE FIT (${WEIGHTS.courseFit}%)** - Which PRIMARY SKILL DEMANDS they satisfy (specific SG stats)
2. **COURSE HISTORY (${WEIGHTS.courseHistory}%)** - Past results here OR explain why no history doesn't matter
3. **RECENT FORM (${WEIGHTS.recentForm}%)** - Mention specific finishes and momentum trend
4. **WEATHER (${WEIGHTS.weather}%)** - How conditions favor this player's game
5. **VALUE (${WEIGHTS.statisticalQuality}%)** - Why odds are too high given all factors above
Keep to 3-4 sentences max.

🚨 FINAL REMINDER BEFORE YOU OUTPUT JSON:
- Pick #1 MUST be odds < 20.0 (a favorite)
- Picks #2-6 MUST be odds >= 20.0 (value picks)
- Double-check your picks array before returning!

Return ONLY valid JSON (no markdown):
{
  "courseType": "Comprehensive description of ${courseInfo.courseName || courseInfo.eventName}${courseInfo.yardage && courseInfo.par ? ` (${courseInfo.yardage} yards, Par ${courseInfo.par})` : ''}. Explain the course setup, primary challenge, what type of player succeeds here, and why this creates betting opportunities.",
  "weatherImpact": "Specific analysis of how the weather conditions will affect scoring and strategy. Which skills become more/less important? How does this create value opportunities?",
  "keyFactors": ["Factor 1: Course characteristic + required skill", "Factor 2: Weather impact + skill adaptation", "Factor 3: Scoring pattern + betting angle", "Factor 4: Historical pattern or course setup insight"],
  "courseNotes": "3-4 sentences analyzing: (1) The course's defining characteristic at ${courseInfo.yardage || 'this'} yards, (2) How weather amplifies or reduces certain demands, (3) What creates betting value - which player types are overpriced vs underpriced, (4) Specific stat ranges that correlate with success here.",
  "picks": [
    {
      "player": "THE FAVORITE - Player Name",
      "odds": 14.0,
      "reasoning": "Pick #1 FAVORITE (UNDER 20/1): Course fit: [Specific SG stats]. Course history: [Past results]. Form: [Recent finishes]. Weather: [How conditions help]. Value: [Why this favorite is better value than lower-odds favorites]."
    },
    {
      "player": "VALUE PICK - Player Name",
      "odds": 35.0,
      "reasoning": "Pick #2 VALUE (20/1+): Course fit: [SG match]. History: [Results or why no history OK]. Form: [Finishes]. Weather: [Impact]. Value: [Market inefficiency]."
    },
    {
      "player": "VALUE PICK - Player Name", 
      "odds": 45.0,
      "reasoning": "Pick #3 VALUE (20/1+): [Same structure as above]"
    },
    {
      "player": "VALUE PICK - Player Name",
      "odds": 55.0,
      "reasoning": "Pick #4 VALUE (20/1+): [Same structure]"
    },
    {
      "player": "VALUE PICK - Player Name",
      "odds": 65.0,
      "reasoning": "Pick #5 VALUE (40/1+): [Same structure]"
    },
    {
      "player": "VALUE PICK - Player Name",
      "odds": 80.0,
      "reasoning": "Pick #6 VALUE (40/1+): [Same structure]"
    }
  ]
}

CRITICAL VALIDATION BEFORE RETURNING:
- Check Pick #1 odds < 20.0 (if not, REJECT and choose different favorite)
- Check Picks #2-6 odds >= 20.0 (if not, REJECT and choose different players)
- Check at least 3 of Picks #2-6 have odds >= 40.0
`;
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
