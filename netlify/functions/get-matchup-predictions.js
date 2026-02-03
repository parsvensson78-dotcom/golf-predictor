const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Matchup Predictor Endpoint
 * Generates AI-powered head-to-head matchup predictions
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

    // Step 2: Get player names from tournament field
    const playerNames = tournament.field?.map(p => p.name) || [];
    if (playerNames.length === 0) {
      throw new Error('No players found in tournament field');
    }

    // Step 3: Fetch odds for these players
    console.log(`[MATCHUP] Fetching odds for ${playerNames.length} players...`);
    const oddsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, {
      tournamentName: tournament.name,
      players: playerNames,
      tour: tournament.tour
    }, {
      timeout: 20000
    });
    const oddsData = oddsResponse.data;
    console.log(`[MATCHUP] Received odds for ${oddsData.odds.length} players`);

    // Step 4: Get top 80 players by odds for detailed stats
    const topPlayerNames = oddsData.odds
      .sort((a, b) => a.odds - b.odds)
      .slice(0, 80)
      .map(o => o.player);
    
    console.log(`[MATCHUP] Fetching stats for top ${topPlayerNames.length} players`);
    
    const statsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, {
      players: topPlayerNames
    }, {
      timeout: 30000
    });
    const statsData = statsResponse.data;

    // Step 5: Get weather forecast
    let weatherData = null;
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const location = tournament.location.split(',')[0].trim();
        const weatherResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-weather-forecast`, {
          location: location,
          startDate: tournament.dates?.split('-')[0]?.trim()
        }, {
          timeout: 8000
        });
        weatherData = weatherResponse.data;
        console.log('[MATCHUP] Weather data retrieved');
      }
    } catch (weatherError) {
      console.error('[MATCHUP] Weather fetch failed:', weatherError.message);
      console.log('[MATCHUP] Continuing with weather unavailable - not critical');
    }

    const weatherSummary = weatherData?.summary || 'Weather data not available';
    console.log(`[MATCHUP] Weather: ${weatherSummary.substring(0, 100)}...`);

    // Step 6: Get course info
    let courseInfo;
    try {
      const courseResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour || 'pga'}&tournament=${encodeURIComponent(tournament.name)}`, {
        timeout: 10000
      });
      courseInfo = courseResponse.data;
    } catch (courseError) {
      console.log('[MATCHUP] Course info fetch failed, using basic info');
      courseInfo = {
        courseName: tournament.course,
        eventName: tournament.name
      };
    }

    // Step 7: Prepare player data with stats and odds (American format)
    const playersWithData = statsData.players
      .map(stat => {
        const oddsEntry = oddsData.odds.find(o => 
          normalizePlayerName(o.player) === normalizePlayerName(stat.player)
        );
        
        if (!oddsEntry) return null;
        
        return {
          name: stat.player,
          rank: stat.stats.rank,
          odds: oddsEntry.odds, // American odds
          minOdds: oddsEntry.minOdds, // Decimal
          maxOdds: oddsEntry.maxOdds, // Decimal
          bookmakerCount: oddsEntry.bookmakerCount || 0,
          sgTotal: stat.stats.sgTotal,
          sgOTT: stat.stats.sgOTT,
          sgAPP: stat.stats.sgAPP,
          sgARG: stat.stats.sgARG,
          sgPutt: stat.stats.sgPutt
        };
      })
      .filter(p => p !== null)
      .sort((a, b) => a.odds - b.odds);

    console.log(`[MATCHUP] ${playersWithData.length} players with complete data`);

    // Step 8: Build prompt for Claude
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildMatchupPrompt(
      tournament,
      playersWithData,
      weatherSummary,
      courseInfo,
      customMatchup
    );

    console.log(`[MATCHUP] Calling Claude API...`);
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
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

    // Step 9: Return matchup predictions
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
        weather: weatherSummary,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to generate matchup predictions',
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
 * Build prompt for Claude's matchup analysis - using American odds
 */
function buildMatchupPrompt(tournament, players, weatherSummary, courseInfo, customMatchup) {
  const formatAmericanOdds = (odds) => odds > 0 ? `+${odds}` : `${odds}`;
  
  // Format top 50 players for analysis
  const topPlayers = players.slice(0, 50);
  const playerList = topPlayers.map(p => 
    `${p.name} [${formatAmericanOdds(p.odds)}] - R${p.rank} | SG:${p.sgTotal?.toFixed(2) || 'N/A'} (OTT:${p.sgOTT?.toFixed(2) || 'N/A'} APP:${p.sgAPP?.toFixed(2) || 'N/A'} ARG:${p.sgARG?.toFixed(2) || 'N/A'} P:${p.sgPutt?.toFixed(2) || 'N/A'})`
  ).join('\n');

  let customMatchupPrompt = '';
  if (customMatchup && customMatchup.playerA && customMatchup.playerB) {
    const playerA = players.find(p => p.name === customMatchup.playerA);
    const playerB = players.find(p => p.name === customMatchup.playerB);
    
    customMatchupPrompt = `
CUSTOM MATCHUP REQUESTED:
Player A: ${playerA?.name || customMatchup.playerA} [${playerA ? formatAmericanOdds(playerA.odds) : '?'}]
Stats: R${playerA?.rank || '?'} | SG:${playerA?.sgTotal?.toFixed(2) || '?'} (OTT:${playerA?.sgOTT?.toFixed(2) || '?'} APP:${playerA?.sgAPP?.toFixed(2) || '?'} ARG:${playerA?.sgARG?.toFixed(2) || '?'} P:${playerA?.sgPutt?.toFixed(2) || '?'})

Player B: ${playerB?.name || customMatchup.playerB} [${playerB ? formatAmericanOdds(playerB.odds) : '?'}]
Stats: R${playerB?.rank || '?'} | SG:${playerB?.sgTotal?.toFixed(2) || '?'} (OTT:${playerB?.sgOTT?.toFixed(2) || '?'} APP:${playerB?.sgAPP?.toFixed(2) || '?'} ARG:${playerB?.sgARG?.toFixed(2) || '?'} P:${playerB?.sgPutt?.toFixed(2) || '?'})

YOU MUST analyze this specific matchup and include it in your response as "customMatchup".
`;
  }

  return `Golf analyst: Generate 4-5 interesting head-to-head matchup predictions.

TOURNAMENT: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName} | ${courseInfo.yardage || '?'}y Par ${courseInfo.par || '?'}
Weather: ${weatherSummary}

TOP PLAYERS (American odds shown):
${playerList}

${customMatchupPrompt}

YOUR TASK:
1. Create 4-5 INTERESTING matchups between players with similar odds (within +500 of each other)
2. Mix of tiers: favorites (+600 to +1500), mid-tier (+1500 to +4000), longshots (+4000 to +8000)
3. Pick winner and provide win probability (52-65% range, be realistic)
${customMatchup ? '4. Analyze the custom matchup requested above' : ''}

ANALYSIS FRAMEWORK:
- Compare SG stats relevant to this course
- Identify stat advantages (who has edge in key categories)
- Consider weather impact
- Provide clear reasoning with specific numbers

Return JSON:
{
  "suggestedMatchups": [
    {
      "playerA": {
        "name": "Player Name",
        "odds": 1800,
        "sgOTT": 0.8,
        "sgAPP": 1.2,
        "sgARG": 0.5,
        "sgPutt": 0.6
      },
      "playerB": {
        "name": "Player Name",
        "odds": 2100,
        "sgOTT": 1.1,
        "sgAPP": 0.4,
        "sgARG": 0.8,
        "sgPutt": 0.3
      },
      "pick": "Player Name",
      "winProbability": 58,
      "confidence": "Medium",
      "reasoning": "3-4 sentences comparing stats and explaining edge. Example: 'Player A's elite SG:APP (+1.2, ranks #8) creates massive advantage on precision course with small greens. Player B's superior driving (#5 in SG:OTT at +1.1) is negated by wide fairways. Weather forecast of calm winds favors accurate ball strikers over bombers.'"
    }
  ]${customMatchup ? `,
  "customMatchup": {
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
    "reasoning": "Detailed analysis"
  }` : ''}
}`;
}
