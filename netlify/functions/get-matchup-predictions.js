const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Matchup Predictor Endpoint
 * Generates AI-powered head-to-head matchup predictions
 * Supports both auto-generated and custom matchups
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { tour, customMatchup } = body;
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[MATCHUP] Starting matchup analysis for ${tour || 'pga'} tour`);

    // Step 1: Fetch tournament data
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour || 'pga'}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;
    console.log(`[MATCHUP] Tournament: ${tournament.name}`);

    // Step 2: Fetch player stats for field
    const playerNames = tournament.field.slice(0, 120).map(p => p.name);
    console.log(`[MATCHUP] Fetching stats for ${playerNames.length} players`);
    
    const statsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, {
      players: playerNames
    }, {
      timeout: 30000
    });
    const statsData = statsResponse.data;

    // Step 3: Fetch odds
    const oddsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, {
      tournamentName: tournament.name,
      players: playerNames
    }, {
      timeout: 20000
    });
    const oddsData = oddsResponse.data;

    console.log(`[MATCHUP] Received odds for ${oddsData.odds.length} players`);

    // Step 4: Get weather
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
      console.error('[MATCHUP] Weather fetch failed:', weatherError.message);
    }

    // Step 5: Get course info
    const courseInfo = await getCourseInfo(tournament.course);

    // Step 6: Prepare player data with stats and odds (WITH CONVERSION)
    const playersWithData = statsData.players
      .map(stat => {
        const oddsEntry = oddsData.odds.find(o => 
          normalizePlayerName(o.player) === normalizePlayerName(stat.player)
        );
        
        // Convert American odds to decimal
        let decimalOdds = null;
        let decimalMinOdds = null;
        let decimalMaxOdds = null;
        
        if (oddsEntry?.odds) {
          decimalOdds = americanToDecimal(oddsEntry.odds);
          decimalMinOdds = oddsEntry.minOdds ? americanToDecimal(oddsEntry.minOdds) : null;
          decimalMaxOdds = oddsEntry.maxOdds ? americanToDecimal(oddsEntry.maxOdds) : null;
          console.log(`[MATCHUP] ${stat.player}: Avg ${decimalOdds.toFixed(1)} | Best ${decimalMinOdds?.toFixed(1)} | Worst ${decimalMaxOdds?.toFixed(1)}`);
        }
        
        return {
          name: stat.player,
          rank: stat.stats.rank,
          odds: decimalOdds, // Average odds in decimal format
          minOdds: decimalMinOdds, // Best odds for bettor
          maxOdds: decimalMaxOdds, // Worst odds for bettor
          americanOdds: oddsEntry?.americanOdds || null,
          bookmakerCount: oddsEntry?.bookmakerCount || 0,
          sgTotal: stat.stats.sgTotal,
          sgOTT: stat.stats.sgOTT,
          sgAPP: stat.stats.sgAPP,
          sgARG: stat.stats.sgARG,
          sgPutt: stat.stats.sgPutt
        };
      })
      .filter(p => p.odds !== null)
      .sort((a, b) => (a.odds || 999) - (b.odds || 999));

    console.log(`[MATCHUP] ${playersWithData.length} players with complete data`);

    // Step 7: Build prompt for Claude
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildMatchupPrompt(
      tournament,
      playersWithData,
      weatherInfo,
      courseInfo,
      customMatchup
    );

    console.log(`[MATCHUP] Calling Claude API...`);
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.4,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    
    // Parse JSON response
    let matchupData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      matchupData = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
      console.log(`[MATCHUP] Analysis complete - ${matchupData.suggestedMatchups?.length || 0} matchups generated`);
    } catch (parseError) {
      console.error('[MATCHUP] Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // Calculate cost
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const inputCost = (inputTokens / 1000000) * 3.00;
    const outputCost = (outputTokens / 1000000) * 15.00;
    const totalCost = inputCost + outputCost;

    // Step 8: Return matchup predictions
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
        courseInfo: courseInfo,
        suggestedMatchups: matchupData.suggestedMatchups || [],
        customMatchup: matchupData.customMatchup || null,
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
    console.error('[MATCHUP] Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to generate matchup predictions',
        message: error.message
      })
    };
  }
};

/**
 * Convert American odds to decimal odds
 */
function americanToDecimal(americanOdds) {
  if (!americanOdds || americanOdds === 0) return null;
  
  if (americanOdds > 0) {
    // Positive American odds: +1800 = 19.0 decimal
    return (americanOdds / 100) + 1;
  } else {
    // Negative American odds: -200 = 1.5 decimal
    return (100 / Math.abs(americanOdds)) + 1;
  }
}

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
 * Get basic course info (simplified version)
 */
async function getCourseInfo(courseName) {
  return {
    name: courseName,
    type: 'Analyze from name',
    keyDemands: ['Ball striking', 'Course management', 'Putting']
  };
}

/**
 * Build prompt for Claude's matchup analysis
 */
function buildMatchupPrompt(tournament, players, weather, courseInfo, customMatchup) {
  // Format top 40 players for analysis
  const topPlayers = players.slice(0, 40);
  const playerList = topPlayers.map(p => 
    `${p.name} [${p.odds.toFixed(1)}] - SG: Total:${p.sgTotal} OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt}`
  ).join('\n');

  let customMatchupPrompt = '';
  if (customMatchup && customMatchup.playerA && customMatchup.playerB) {
    const playerA = players.find(p => p.name === customMatchup.playerA);
    const playerB = players.find(p => p.name === customMatchup.playerB);
    
    customMatchupPrompt = `
CUSTOM MATCHUP REQUESTED:
Player A: ${playerA?.name || customMatchup.playerA} [${playerA?.odds?.toFixed(1) || '?'}]
Stats: SG Total:${playerA?.sgTotal || '?'} OTT:${playerA?.sgOTT || '?'} APP:${playerA?.sgAPP || '?'} ARG:${playerA?.sgARG || '?'} Putt:${playerA?.sgPutt || '?'}

Player B: ${playerB?.name || customMatchup.playerB} [${playerB?.odds?.toFixed(1) || '?'}]
Stats: SG Total:${playerB?.sgTotal || '?'} OTT:${playerB?.sgOTT || '?'} APP:${playerB?.sgAPP || '?'} ARG:${playerB?.sgARG || '?'} Putt:${playerB?.sgPutt || '?'}

YOU MUST analyze this specific matchup and include it in your response as "customMatchup".
`;
  }

  return `You are a professional golf analyst specializing in head-to-head matchup predictions.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

COURSE TYPE:
The course rewards: ${courseInfo.keyDemands.join(', ')}

TOP PLAYERS IN FIELD WITH STATS (decimal odds shown):
${playerList}

${customMatchupPrompt}

YOUR TASK:
1. Identify 4-5 INTERESTING suggested matchups between players with similar odds (within 10.0 of each other)
2. For each matchup, analyze stats, course fit, and weather impact
3. Pick a winner and provide win probability
${customMatchup ? '4. Analyze the custom matchup requested above' : ''}

MATCHUP SELECTION CRITERIA:
- Choose players with similar decimal odds (makes it interesting)
- Mix of favorites (10-30), mid-tier (30-60), and longshots (60-100)
- Look for stat advantages that create clear edges
- Consider course fit differences

ANALYSIS FRAMEWORK:
- Compare SG stats relevant to this course
- Identify which player's strengths better match course demands
- Consider weather impact on each player's game
- Provide win probability (50-80% range, be realistic)
- Explain confidence level (Low/Medium/High)

Return ONLY valid JSON (no markdown):
{
  "suggestedMatchups": [
    {
      "playerA": {
        "name": "Player Name",
        "odds": 22.0,
        "sgOTT": 0.8,
        "sgAPP": 1.2,
        "sgARG": 0.5,
        "sgPutt": 0.6
      },
      "playerB": {
        "name": "Player Name",
        "odds": 24.0,
        "sgOTT": 1.1,
        "sgAPP": 0.4,
        "sgARG": 0.8,
        "sgPutt": 0.3
      },
      "pick": "Player Name",
      "winProbability": 58,
      "confidence": "Medium-High",
      "reasoning": "Detailed 3-4 sentence analysis comparing their stats, explaining why pick has the edge. Include specific SG stats and course fit reasoning. Example: 'Player A ranks #8 in SG:APP (1.2) vs Player B at #45 (0.4). On a course demanding precise iron play to small greens, this creates a massive advantage. Player B's superior driving (#5 SG:OTT) is negated by wide fairways. Weather forecast of 15mph winds further favors accurate ball strikers.'"
    }
  ],
  "customMatchup": ${customMatchup ? `{
    "playerA": {
      "name": "${customMatchup.playerA}",
      "odds": null,
      "sgOTT": null,
      "sgAPP": null,
      "sgARG": null,
      "sgPutt": null
    },
    "playerB": {
      "name": "${customMatchup.playerB}",
      "odds": null,
      "sgOTT": null,
      "sgAPP": null,
      "sgARG": null,
      "sgPutt": null
    },
    "pick": "Player Name",
    "winProbability": 55,
    "confidence": "Medium",
    "reasoning": "Detailed analysis of this specific matchup"
  }` : 'null'}
}

Be specific with stat comparisons and explain WHY one player has the edge on THIS course with THIS weather.`;
}
