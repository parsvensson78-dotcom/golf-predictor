const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Avoid Picks Endpoint - Separate from main predictions
 * Identifies players to avoid based on poor course fit
 */
exports.handler = async (event, context) => {
  // Helper function - define at top
  const formatAmericanOdds = (odds) => odds > 0 ? `+${odds}` : `${odds}`;
  
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

    // Step 5: Get weather
    let weatherInfo = 'Weather data not available';
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const location = tournament.location.split(',')[0].trim();
        const weatherResponse = await axios.get(`https://api.weatherapi.com/v1/current.json`, {
          params: { key: weatherApiKey, q: location, aqi: 'no' },
          timeout: 8000
        });
        
        if (weatherResponse.data && weatherResponse.data.current) {
          const current = weatherResponse.data.current;
          weatherInfo = `${Math.round(current.temp_f)}°F, ${current.condition.text}, Wind: ${Math.round(current.wind_mph)}mph`;
        }
      }
    } catch (weatherError) {
      console.error('[AVOID] Weather fetch failed:', weatherError.message);
    }

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

    // Step 7: Get course info
    const courseInfo = getCourseBasicInfo(tournament.course);

    // Step 8: Call Claude for avoid picks
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildAvoidPicksPrompt(
      tournament,
      playersWithOdds,
      weatherInfo,
      courseInfo,
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

    // Calculate cost
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const inputCost = (inputTokens / 1000000) * 3.00;
    const outputCost = (outputTokens / 1000000) * 15.00;
    const totalCost = inputCost + outputCost;

    // Return avoid picks
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
        weather: weatherInfo,
        avoidPicks: avoidData.avoid || [],
        reasoning: avoidData.reasoning || '',
        generatedAt: new Date().toISOString(),
        tokensUsed: inputTokens + outputTokens,
        tokenBreakdown: {
          input: inputTokens,
          output: outputTokens
        },
        estimatedCost: {
          inputCost: inputCost,
          outputCost: outputCost,
          totalCost: totalCost,
          formatted: `$${totalCost.toFixed(4)}`
        }
      })
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
function normalizePlayerName(name) {
  let normalized = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const parts = normalized.split(' ');
  return parts.sort().join(' ');
}

/**
 * Get basic course info
 */
function getCourseBasicInfo(courseName) {
  return {
    name: courseName,
    demands: ['To be analyzed from name and characteristics']
  };
}

/**
 * Build prompt for avoid picks - ONLY analyzes top favorites
 */
function buildAvoidPicksPrompt(tournament, players, weather, courseInfo, excludePlayers = []) {
  const formatAmericanOdds = (odds) => odds > 0 ? `+${odds}` : `${odds}`;
  
  const playerList = players.map((p, i) => 
    `#${i+1}. ${p.player} [${formatAmericanOdds(p.odds)}] - R${p.stats.rank} | SG:${p.stats.sgTotal?.toFixed(2) || 'N/A'} (OTT:${p.stats.sgOTT?.toFixed(2) || 'N/A'} APP:${p.stats.sgAPP?.toFixed(2) || 'N/A'} ARG:${p.stats.sgARG?.toFixed(2) || 'N/A'} P:${p.stats.sgPutt?.toFixed(2) || 'N/A'})`
  ).join('\n');

  const exclusionWarning = excludePlayers.length > 0 
    ? `\n🚫 DO NOT PICK THESE PLAYERS (already recommended as value picks):\n${excludePlayers.join(', ')}\n` 
    : '';

  return `You are identifying PUBLIC FAVORITES to AVOID - the top betting favorites with poor course fit.

TOURNAMENT: ${tournament.name}
Course: ${tournament.course}
Weather: ${weather}
${exclusionWarning}
TOP ${players.length} FAVORITES (shortest odds = most bet on):
${playerList}

CRITICAL CONTEXT:
- These are the PUBLIC FAVORITES (shortest odds in entire field)
- The market is backing these players heavily
- Your job: Find which 3 have WORST course fit despite being favorites
- Look for OVERVALUED favorites whose stats DON'T fit this course
${excludePlayers.length > 0 ? `- IMPORTANT: DO NOT select any of these players: ${excludePlayers.join(', ')}` : ''}

WHAT TO LOOK FOR:
❌ Player is top 5 favorite BUT ranks #80+ in key stat for this course
❌ Player has short odds BUT historically struggles at this venue
❌ Player's strength is OPPOSITE of what course demands

Your task: Find 3 PUBLIC FAVORITES (from list above) with WORST course fit.
${excludePlayers.length > 0 ? `\nREMINDER: You CANNOT pick: ${excludePlayers.join(', ')}` : ''}

Return JSON:
{
  "reasoning": "What this course demands that these favorites lack (2-3 sentences)",
  "avoid": [
    {
      "player": "Must be from the top ${players.length} list above (NOT from excluded list)",
      "odds": 600,
      "reasoning": "Why THIS FAVORITE has poor fit. Include: stat rankings showing weakness, course history if poor, why odds too short given mismatch. 3-4 sentences with specific numbers."
    }
  ]
}`;
}
