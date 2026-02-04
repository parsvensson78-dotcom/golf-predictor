const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const {
  getBlobStore,
  normalizePlayerName,
  formatAmericanOdds,
  analyzeCourseSkillDemands,
  analyzeWeatherConditions,
  calculateClaudeCost,
  generateBlobKey
} = require('./shared-utils');

/**
 * Avoid Picks Endpoint - OPTIMIZED VERSION v2
 * NOW USES SHARED-UTILS.JS
 * Identifies players to avoid based on poor course fit
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { tour, excludePlayers = [] } = body;
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[AVOID] Starting avoid picks analysis for ${tour || 'pga'} tour`);
    if (excludePlayers.length > 0) {
      console.log(`[AVOID] Excluding ${excludePlayers.length} players from value picks: ${excludePlayers.join(', ')}`);
    }

    // Step 1: Fetch tournament data
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour || 'pga'}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;
    console.log(`[AVOID] Tournament: ${tournament.name} with ${tournament.field?.length || 0} players`);

    // Step 2: Get player names from tournament field
    const playerNames = tournament.field?.map(p => p.name) || [];
    if (playerNames.length === 0) {
      console.log('[AVOID] No players in tournament field');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament: { name: tournament.name, course: tournament.course },
          avoidPicks: [],
          reasoning: 'No players found in tournament field',
          generatedAt: new Date().toISOString()
        })
      };
    }

    // Step 3: Fetch odds for these players
    console.log(`[AVOID] Fetching odds for ${playerNames.length} players...`);
    const oddsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, {
      tournamentName: tournament.name,
      players: playerNames,
      tour: tournament.tour
    }, {
      timeout: 20000
    });
    const oddsData = oddsResponse.data;
    console.log(`[AVOID] Received odds for ${oddsData.odds.length} players`);

    // Step 4: Get ONLY top 10 favorites by odds (shortest odds = market favorites)
    // These are the players we want to potentially avoid - the public favorites
    // But exclude any players already recommended in value picks
    const topFavorites = oddsData.odds
      .sort((a, b) => a.odds - b.odds)
      .filter(o => !excludePlayers.some(excluded => 
        normalizePlayerName(excluded) === normalizePlayerName(o.player)
      ))
      .slice(0, 15); // Top 15 shortest odds (after exclusions)
    
    const favoriteNames = topFavorites.map(o => o.player);
    
    console.log(`[AVOID] Analyzing top ${favoriteNames.length} favorites (shortest odds)`);
    if (topFavorites.length > 0) {
      console.log(`[AVOID] Odds range: ${formatAmericanOdds(topFavorites[0].odds)} to ${formatAmericanOdds(topFavorites[topFavorites.length-1].odds)}`);
    }
    
    const statsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, {
      players: favoriteNames
    }, {
      timeout: 25000
    });
    const statsData = statsResponse.data;

    // Step 5: Get weather forecast (fetch directly from Weather API like get-predictions)
    let weatherData = null;
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const location = tournament.location.split(',')[0].trim();
        
        console.log('[AVOID] Fetching weather forecast...');
        const weatherResponse = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
          params: {
            key: weatherApiKey,
            q: location,
            days: 4,
            aqi: 'no'
          },
          timeout: 8000
        });

        if (weatherResponse.data?.forecast) {
          const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
          const daily = weatherResponse.data.forecast.forecastday.map((day, index) => ({
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

          weatherData = { summary, daily };
          console.log('[AVOID] Weather data retrieved');
        }
      }
    } catch (weatherError) {
      console.error('[AVOID] Weather fetch failed:', weatherError.message);
    }

    const weatherSummary = weatherData?.summary || 'Weather data not available';

    // Step 6: Build player data for TOP FAVORITES only
    const playersWithOdds = statsData.players
      .map(stat => {
        const oddsEntry = topFavorites.find(o => 
          normalizePlayerName(o.player) === normalizePlayerName(stat.player)
        );
        
        if (!oddsEntry) return null;
        
        return {
          player: stat.player,
          odds: oddsEntry.odds,
          minOdds: oddsEntry.minOdds,
          maxOdds: oddsEntry.maxOdds,
          bookmakerCount: oddsEntry.bookmakerCount || 0,
          stats: stat.stats
        };
      })
      .filter(p => p !== null)
      .sort((a, b) => a.odds - b.odds);

    console.log(`[AVOID] ${playersWithOdds.length} top favorites ready for analysis`);

    // Step 7: Get course info with proper analysis
    let courseInfo;
    try {
      const courseResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour || 'pga'}&tournament=${encodeURIComponent(tournament.name)}`, {
        timeout: 10000
      });
      courseInfo = courseResponse.data;
    } catch (courseError) {
      console.log('[AVOID] Course info fetch failed, using basic info');
      courseInfo = {
        courseName: tournament.course,
        eventName: tournament.name
      };
    }

    // Analyze course demands (same as get-predictions)
    const courseDemands = analyzeCourseSkillDemands(courseInfo);
    const weatherAnalysis = analyzeWeatherConditions(weatherSummary);

    // Step 8: Call Claude for avoid picks
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildAvoidPicksPrompt(
      tournament,
      playersWithOdds,
      courseInfo,
      courseDemands,
      weatherAnalysis,
      excludePlayers
    );

    console.log(`[AVOID] Calling Claude API...`);
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    
    // Parse JSON response
    let avoidData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      avoidData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
      console.log(`[AVOID] Analysis complete, ${avoidData.avoid?.length || 0} avoid picks`);
    } catch (parseError) {
      console.error('[AVOID] Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // Calculate cost using shared utility
    const cost = calculateClaudeCost(message.usage);

    // Prepare response data
    const responseData = {
      tournament: {
        name: tournament.name,
        course: tournament.course,
        location: tournament.location,
        dates: tournament.dates,
        tour: tournament.tour
      },
      weather: weatherSummary,
      avoidPicks: avoidData.avoid || [],
      reasoning: avoidData.reasoning || '',
      generatedAt: new Date().toISOString(),
      tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      tokenBreakdown: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens
      },
      estimatedCost: cost
    };

    // Save to Netlify Blobs for caching
    try {
      await saveAvoidPicksToBlobs(responseData, context);
      console.log('[AVOID] ✅ Saved to Blobs for caching');
    } catch (saveError) {
      console.error('[AVOID] Failed to save to Blobs:', saveError.message);
      // Don't fail the request if save fails
    }

    // Return avoid picks
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify(responseData)
    };

  } catch (error) {
    console.error('[AVOID] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to generate avoid picks',
        message: error.message
      })
    };
  }
};

/**
 * Normalize player name for matching
 */
/**
 * Build prompt for avoid picks - same analytical depth as get-predictions
 */
function buildAvoidPicksPrompt(tournament, players, courseInfo, courseDemands, weatherAnalysis, excludePlayers = []) {
  const playerList = players.map((p, i) => 
    `${p.player} [${formatAmericanOdds(p.odds)}] - R${p.stats.rank} | SG:${p.stats.sgTotal?.toFixed(2) || 'N/A'} (OTT:${p.stats.sgOTT?.toFixed(2) || 'N/A'} APP:${p.stats.sgAPP?.toFixed(2) || 'N/A'} ARG:${p.stats.sgARG?.toFixed(2) || 'N/A'} P:${p.stats.sgPutt?.toFixed(2) || 'N/A'})`
  ).join('\n');

  const exclusionWarning = excludePlayers.length > 0 
    ? `\n🚫 EXCLUDED (already recommended as value picks - DO NOT select):\n${excludePlayers.join(', ')}\n` 
    : '';

  return `Golf analyst: Find 3 PUBLIC FAVORITES to AVOID based on poor course fit.

TOURNAMENT: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName} | ${courseInfo.yardage || '?'}y Par ${courseInfo.par || '?'}
Course Demands: ${courseDemands}
Weather Analysis: ${weatherAnalysis}
${exclusionWarning}
TOP ${players.length} PUBLIC FAVORITES (shortest odds in field):
${playerList}

ANALYSIS FRAMEWORK (same as value picks):
1. Course Fit (40%): Does their SG profile MISMATCH course demands?
2. Course History (20%): Poor results at this venue?
3. Recent Form (15%): Cold streak or inconsistent?
4. Weather (15%): Do conditions expose their weaknesses?
5. Value Assessment: Are odds too SHORT given above negatives?

YOUR TASK:
Identify exactly 3 players who should be AVOIDED because:
- They are PUBLIC FAVORITES (short odds = market backing)
- BUT they have POOR statistical fit for THIS specific course
- Their SG stats DON'T match what the course demands

CRITICAL REQUIREMENTS:
${excludePlayers.length > 0 ? `- You CANNOT select: ${excludePlayers.join(', ')} (already in value picks)` : ''}
- Focus on STATISTICAL MISMATCHES between player strengths and course demands
- Compare their SG stats to course demands above
- Explain WHY their profile is WRONG for this course

EXAMPLES OF GOOD AVOID REASONING:

GOOD: 
"Course fit: His SG:APP (+0.25, ranks #85) is far below the elite level needed for this precision course with small, elevated greens - course demands show 'SG:APP CRITICAL' but his approach game is merely average.

History: No previous appearances at this venue.

Form: Recent inconsistency with T45, MC, T22 in last 5 starts shows lack of momentum.

Weather: Wind analysis favors ball-strikers, which isn't his primary strength.

Value: At +800 (4th favorite), public overvalues name recognition over statistical course fit."

BAD: "Good stats but overpriced" ← NO! Must show SPECIFIC stat mismatch with course demands!

WEIGHTS: Course Fit 40%, History 20%, Form 15%, Weather 15%, Value 10%

REASONING FORMAT - Use this EXACT structure with line breaks between sections:
"Course fit: [Specific SG weakness vs course demands with numbers].

History: [Poor results here or no history context].

Form: [Recent struggles with specific finishes].

Weather: [How conditions hurt their game].

Value: [Why odds too short given above factors]."

Return JSON with exactly 3 avoid picks:
{
  "reasoning": "What this course demands and why these favorites don't have it (2-3 sentences)",
  "avoid": [
    {
      "player": "Must be from top ${players.length} list (NOT excluded list)",
      "odds": 800,
      "reasoning": "STRUCTURED FORMAT with line breaks:\n\nCourse fit: [Specific analysis].\n\nHistory: [Results].\n\nForm: [Recent finishes].\n\nWeather: [Impact].\n\nValue: [Assessment]."
    }
  ]
}`;
}

/**
 * Save avoid picks to Netlify Blobs for caching
 */
async function saveAvoidPicksToBlobs(responseData, context) {
  const store = getBlobStore('avoid-picks', context);
  const key = generateBlobKey(responseData.tournament.name, responseData.tournament.tour, responseData.generatedAt);

  await store.set(key, JSON.stringify(responseData));
  console.log(`[AVOID] Saved to blob: ${key}`);
}
