const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const {
  getBlobStore,
  normalizePlayerName,
  formatAmericanOdds,
  americanToDecimal,
  analyzeCourseSkillDemands,
  analyzeWeatherConditions,
  calculateClaudeCost,
  generateBlobKey,
  generatePlayerDataCacheKey,
  isCacheValidForTournament
} = require('./shared-utils');

/**
 * Main prediction endpoint - OPTIMIZED VERSION v3
 * NOW USES SHARED-UTILS.JS
 * OPTIMIZATIONS:
 * - Uses shared utilities (eliminates 300+ lines of duplicated code)
 * - All helper functions centralized in shared-utils
 * - Consistent across all endpoints
 */

exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const reqId = event.queryStringParameters?.reqId || 'unknown';
    const forceRefresh = event.queryStringParameters?.refresh === 'true';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[START] Predictions for ${tour.toUpperCase()} tour - Request ID: ${reqId}${forceRefresh ? ' (FORCE REFRESH)' : ''}`);

    // Step 1: ALWAYS fetch current tournament info first (lightweight call)
    // This ensures we know WHICH tournament we're dealing with before checking cache
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;

    if (!tournament?.field?.length) {
      throw new Error('No tournament field data available');
    }

    console.log(`[TOURNAMENT] ${tournament.name} (${tournament.field.length} players)`);

    // Step 2: Try to get cached player data (unless force refresh)
    // Cache key is now TOURNAMENT-SPECIFIC so different weeks never collide
    const cacheKey = generatePlayerDataCacheKey(tour, tournament.name);
    let playersWithData = null;
    let weatherData = null;
    let courseInfo = null;
    
    if (!forceRefresh) {
      try {
        const store = getBlobStore('cache', context);
        const cached = await store.get(cacheKey, { type: 'json' });
        
        if (isCacheValidForTournament(cached, tournament.name)) {
          const cacheAge = Date.now() - cached.timestamp;
          console.log(`[CACHE] ✅ Using cached player data for "${tournament.name}" (${Math.round(cacheAge / 1000 / 60)} min old)`);
          playersWithData = cached.players;
          courseInfo = cached.courseInfo;
          // NOTE: Weather is no longer cached with player data - it has its own 3h cache
        } else {
          console.log(`[CACHE] Cache miss or invalid for "${tournament.name}" - fetching fresh data`);
        }
      } catch (cacheError) {
        console.log(`[CACHE] Error reading cache: ${cacheError.message}`);
      }
    } else {
      console.log(`[CACHE] Force refresh requested - bypassing cache`);
    }

    // Step 2.5: ALWAYS fetch weather separately (has its own 3h cache via fetch-weather function)
    // This ensures weather is always fresh even when player data is cached
    try {
      const weatherResponse = await axios.get(
        `${baseUrl}/.netlify/functions/fetch-weather?location=${encodeURIComponent(tournament.location)}&tournament=${encodeURIComponent(tournament.name)}&tour=${tour}`,
        { timeout: 10000 }
      );
      weatherData = weatherResponse.data;
      console.log(`[WEATHER] Got forecast (cached: ${weatherData.cached || false}, fetchedAt: ${weatherData.fetchedAt || 'unknown'})`);
    } catch (weatherErr) {
      console.log(`[WEATHER] ⚠️ Weather service failed: ${weatherErr.message}, using fallback`);
      weatherData = { summary: 'Weather data not available', daily: [] };
    }

    // Step 3: If no valid player cache, fetch all data (except weather)
    if (!playersWithData) {
      console.log(`[FETCH] Fetching fresh player data for "${tournament.name}"...`);

      const playerNames = tournament.field.map(p => p.name);

      // Fetch stats, odds, course info, and form IN PARALLEL (weather already fetched above)
      const [statsResponse, oddsResponse, courseInfoResponse, recentFormData] = await Promise.all([
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
        // Course info
        axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour}&tournament=${encodeURIComponent(tournament.name)}`, 
          { timeout: 10000 }
        ).then(r => r.data),
        // Recent form and course history
        fetchRecentFormAndHistory(playerNames, tournament.course, tour)
      ]);

      const statsData = statsResponse.data;
      const oddsData = oddsResponse.data;
      courseInfo = courseInfoResponse;

      console.log(`[DATA] Stats: ${statsData.players.length}, Odds: ${oddsData.odds.length}, Course: ${courseInfo.courseName || courseInfo.eventName}, Form data: ${recentFormData.players.length}`);

      // Step 2f: Merge player data (stats + odds + form)
      playersWithData = mergePlayerData(statsData.players, oddsData.odds, recentFormData.players);

      console.log(`[MERGE] ${playersWithData.length} players with complete data`);
      
      // Step 3g: Save player data to cache (NO weather - that has its own cache)
      try {
        const store = getBlobStore('cache', context);
        await store.set(cacheKey, JSON.stringify({
          timestamp: Date.now(),
          tournament: { name: tournament.name, eventId: tournament.eventId },
          players: playersWithData,
          courseInfo: courseInfo
        }));
        
        console.log(`[CACHE] ✅ Saved fresh player data to cache (key: ${cacheKey})`);
      } catch (cacheError) {
        console.log(`[CACHE] ⚠️  Failed to save cache: ${cacheError.message}`);
      }
    }

    // Step 3: Select top 80 players by odds (lower odds = higher ranked)
    // Testing if this completes under 28 seconds for Netlify timeout
    const topPlayers = playersWithData
      .sort((a, b) => a.odds - b.odds)
      .slice(0, 80);
    
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
    
    // Step 6: Enrich predictions with odds breakdown
    try {
      enrichPredictionsWithOdds(predictions, topPlayers);
      console.log(`[ENRICH] ✅ Added odds breakdown to predictions`);
    } catch (enrichError) {
      console.error(`[ENRICH] ❌ Failed to enrich predictions:`, enrichError.message);
      // Continue anyway - enrichment is not critical
    }

    // Step 8: Calculate costs
    const cost = calculateClaudeCost(message.usage);

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
      
      // Wrap save in timeout to prevent blocking request
      await Promise.race([
        savePredictionsToBlobs(responseData, context),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Blob save timeout after 3s')), 3000)
        )
      ]);
      
      console.log('[SAVE] ✅ Predictions saved for results tracking');
    } catch (saveError) {
      console.error('[SAVE] Failed to save predictions:', saveError.message);
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
 * NOTE: Weather fetching has been moved to its own Netlify function (fetch-weather.js)
 * with separate 3h caching and historical tracking.
 * The old inline fetchWeather() function has been removed.
 */

/**
 * Fetch recent form and course history for players
 */
async function fetchRecentFormAndHistory(playerNames, courseName, tour) {
  const apiKey = process.env.DATAGOLF_API_KEY;
  
  if (!apiKey) {
    console.log('[FORM] DataGolf API key not configured, skipping form data');
    return { players: [] };
  }
  
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
    
    // Get completed tournaments (where tournament finished at least 2 days ago)
    const completedTournaments = tournaments
      .filter(t => {
        // Try to find tournament end date
        let tourneyEndDate;
        
        if (t.end_date) {
          tourneyEndDate = new Date(t.end_date);
        } else if (t.start_date) {
          // If only start_date, assume 4-day tournament
          tourneyEndDate = new Date(t.start_date);
          tourneyEndDate.setDate(tourneyEndDate.getDate() + 4);
        } else if (t.date) {
          // If generic date, assume it's start date + 4 days
          tourneyEndDate = new Date(t.date);
          tourneyEndDate.setDate(tourneyEndDate.getDate() + 4);
        } else {
          return false;
        }
        
        // Tournament is completed if it ended at least 1 day ago
        const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
        return tourneyEndDate < oneDayAgo;
      })
      .sort((a, b) => {
        const aDate = new Date(a.end_date || a.start_date || a.date);
        const bDate = new Date(b.end_date || b.start_date || b.date);
        return bDate - aDate;
      })
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
 * Build enhanced prompt for Claude with weather analysis
 * 
 * WEIGHT RATIONALE (updated based on self-analysis):
 * - Course Fit 35%: Still primary, but not so dominant it crowds out other signals
 * - Course History 25%: Increased — venue-specific results are the strongest predictor
 * - Recent Form 20%: Stable — recent momentum matters but less than venue fit  
 * - Weather 10%: Halved — forecasts are often wrong, should never override fit/history
 * - Quality 10%: Floor check — elite players have baseline edge
 */
function buildClaudePrompt(tournament, players, weatherSummary, courseInfo) {
  // ========================================
  // 🎯 WEIGHTING CONFIGURATION - EDIT HERE
  // ========================================
  const WEIGHTS = {
    courseFit: 35,           // % - How well stats match course demands
    courseHistory: 25,       // % - Past results at this venue (THE strongest signal)
    recentForm: 20,          // % - Last 5 tournaments performance
    weather: 10,             // % - Weather adaptation (LOW - forecasts unreliable)
    statisticalQuality: 10   // % - Overall player quality check
  };
  
  // When player has NO course history, redistribute that 25% weight:
  const WEIGHTS_NO_HISTORY = {
    courseFit: 40,           // Absorbs most of history weight
    recentForm: 25,          // Form matters more without history
    venueTypeExp: 15,        // NEW: experience at SIMILAR venue types
    weather: 10,             // Still low
    statisticalQuality: 10   // Same
  };
  // ========================================
  
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  // Analyze weather conditions
  const weatherAnalysis = analyzeWeatherConditions(weatherSummary);

  // Determine primary course demands based on characteristics
  const courseDemands = analyzeCourseSkillDemands(courseInfo);

  // Determine venue type
  const venueType = classifyVenueType(courseInfo, tournament);

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
Venue type: ${venueType}
Greens: ${courseInfo.greens || 'Unknown'}

Course demands:
${courseDemands}

Weather forecast:
${weatherAnalysis}

⚠️ WEATHER RELIABILITY WARNING: Weather forecasts are often significantly wrong (temperature ±10°F, wind ±10mph is common). Use weather as a TIEBREAKER only, never as a primary reason for picking or avoiding a player. Course fit and course history are far more reliable signals.

PLAYERS (sorted by odds):
${formatPlayerList(players)}

WEIGHTS: Course Fit 35%, Course History 25%, Recent Form 20%, Weather 10%, Quality 10%

IMPORTANT ANALYSIS RULES:
1. COURSE HISTORY IS KING: A player with strong history at this specific venue (multiple top-20s or better) should be weighted heavily even if other stats are mediocre. Past venue performance is the single most predictive factor in golf.
2. VENUE TYPE MATTERS: When a player has no history at THIS course, look for results at similar venue types (${venueType}). A player who thrives at desert courses but has never played this specific desert course still has an edge over someone with no desert experience.
3. PUTTING CONTEXT: Do NOT treat SG:Putt as a standalone predictor. SG:Putt varies enormously by green type (bentgrass vs bermuda vs poa). A player ranked #5 in SG:Putt on bentgrass may putt poorly on bermuda. Consider the green surface (${courseInfo.greens || 'unknown'}) when evaluating putting stats.
4. WEATHER IS A TIEBREAKER: Weather should only influence your pick when two players are otherwise equal. Never pick a player primarily because of weather conditions, and never avoid one primarily for weather.
5. DIVERSIFICATION: Your 6 picks MUST represent at least 3 different player profiles. If you notice 3+ picks share the same primary strength (e.g., all elite putters, or all bombers), REPLACE one with a differently-profiled player. Diversification reduces model risk.

PICK REQUIREMENTS:
- Pick #1: <+1900 (best VALUE favorite, NOT lowest odds)
- Picks #2-6: +1900+ (at least 3 picks +4000+)

REASONING FORMAT - Use this EXACT structure with line breaks:
"Course fit: [Specific SG stat matching course demands, with green surface context for putting].

History: [Results at THIS venue. If none, results at similar ${venueType} venues].

Form: [Last 3-5 tournaments with specific finishes and momentum direction].

Weather: [Brief note only - how conditions mildly favor/disfavor, NOT a primary factor].

Differentiation: [What makes this pick DIFFERENT from your other picks - unique skill or angle].

Value: [Why odds undervalue given above factors]."

Example: 
"Course fit: Elite SG:APP (+0.59, #12 on tour) matches this precision course. Strong bermuda putting history complements his iron play.

History: T8, T4, T12 in last three visits — consistent top-20 performer here proving genuine course fit.

Form: Hot streak with T3, T8, 2nd in last 5 starts shows excellent momentum entering the week.

Weather: Calm conditions slightly favor his accuracy-over-power game, but this is a minor factor.

Differentiation: Only pick with elite course history + hot form combo; other picks rely more on statistical profile.

Value: At +2800, market undervalues his elite course history. Three straight top-12s here should make him +1800 at most."

DIVERSIFICATION CHECK (do this before returning):
- List the primary strength of each pick (e.g., "OTT bomber", "elite putter", "iron precision", "scrambler", "course horse", "form player")
- If 3+ picks share the same primary label → replace the weakest with a differently-profiled player
- Ensure at least 1 pick is primarily a "course history" pick (strong venue results)

CHECK BEFORE RETURNING:
- Pick #1 < +1900? Picks #2-6 all +1900+? 3+ picks +4000+?
- At least 3 different player profiles across all 6 picks?
- No pick where weather is the #1 reason?

Return JSON:
{
  "courseType": "Brief analysis (2 sentences)",
  "weatherImpact": "Impact (1-2 sentences, acknowledge forecast uncertainty)",
  "keyFactors": ["Factor 1", "Factor 2", "Factor 3"],
  "courseNotes": "Betting insights (2 sentences)",
  "pickProfiles": ["profile label for each pick, e.g. course horse, iron specialist, form player, bomber, scrambler, putter"],
  "picks": [
    {"player": "Name", "odds": 1400, "reasoning": "STRUCTURED FORMAT with line breaks:\\n\\nCourse fit: [Analysis].\\n\\nHistory: [Results].\\n\\nForm: [Finishes].\\n\\nWeather: [Brief tiebreaker note].\\n\\nDifferentiation: [Unique angle].\\n\\nValue: [Assessment]."}
  ]
}`; 
}

/**
 * Classify venue type based on course info and tournament name/location
 * Used to find players with experience at similar venues
 */
function classifyVenueType(courseInfo, tournament) {
  const name = (tournament.name || '').toLowerCase();
  const course = (courseInfo.courseName || courseInfo.eventName || '').toLowerCase();
  const location = (tournament.location || courseInfo.location || '').toLowerCase();
  const features = (courseInfo.keyFeatures || []).join(' ').toLowerCase();
  const all = `${name} ${course} ${location} ${features}`;

  // Desert courses
  if (all.match(/scottsdale|phoenix|tucson|vegas|las vegas|desert|tpc scottsdale|pga west|la quinta/)) {
    return 'Desert (dry, firm fairways, wide open, wind variable, overseeded bermuda)';
  }
  // Links courses
  if (all.match(/links|st andrews|open championship|royal|carnoustie|muirfield|pot bunkers|fescue/)) {
    return 'Links (wind-exposed, firm & fast, pot bunkers, fescue rough, creative shotmaking)';
  }
  // Coastal
  if (all.match(/pebble|torrey|harbour|hilton head|kiawah|sea island|coastal|ocean/)) {
    return 'Coastal (wind exposure, marine layer, firm greens, links-influenced)';
  }
  // Mountain
  if (all.match(/altitude|mountain|castle pines|crans|elevation/)) {
    return 'Mountain (altitude affects distance, elevation changes, thin air)';
  }
  // Resort
  if (all.match(/resort|kapalua|waialae|bermuda|caribbean|mexico|mayakoba/)) {
    return 'Resort/Tropical (bermuda grass, wind, humidity, paspalum greens possible)';
  }
  // Classic parkland
  if (all.match(/augusta|colonial|muirfield village|oak|memorial|quail|southern hills|east lake/)) {
    return 'Championship Parkland (premium ball-striking, tough rough, fast greens, historic venue)';
  }
  // TPC/Stadium
  if (all.match(/tpc|stadium|sawgrass|players/)) {
    return 'TPC/Stadium (spectator course, island greens, penal rough, premium approach play)';
  }

  // Default based on region
  if (all.match(/florida|georgia|carolina|south|bermuda grass/)) {
    return 'Southern Parkland (bermuda grass, humidity, afternoon storms possible)';
  }
  if (all.match(/northeast|midwest|bentgrass|pennsylvania|ohio|new york|connecticut/)) {
    return 'Northern Parkland (bentgrass, traditional layout, cooler conditions)';
  }

  return 'Parkland (standard tour venue)';
}

/**
 * Save predictions to Netlify Blobs for results tracking
 */
async function savePredictionsToBlobs(responseData, context) {
  const store = getBlobStore('predictions', context);
  const key = generateBlobKey(responseData.tournament.name, responseData.tournament.tour, responseData.generatedAt);

  // Save EXACTLY the same data structure as returned to user
  const predictionData = {
    tournament: responseData.tournament,
    weather: responseData.weather,
    dailyForecast: responseData.dailyForecast,
    courseInfo: responseData.courseInfo,
    courseAnalysis: responseData.courseAnalysis,
    predictions: responseData.predictions,
    generatedAt: responseData.generatedAt,
    tokensUsed: responseData.tokensUsed,
    tokenBreakdown: responseData.tokenBreakdown,
    estimatedCost: responseData.estimatedCost,
    metadata: {
      savedAt: new Date().toISOString(),
      pickCount: responseData.predictions.length,
      status: 'pending'
    }
  };

  await store.set(key, JSON.stringify(predictionData));
  console.log(`[SAVE] Saved to blob: ${key}`);
}
