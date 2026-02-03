const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Avoid Picks Endpoint - Separate from main predictions
 * Identifies players to avoid based on poor course fit
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { tour } = body;
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[AVOID] Starting avoid picks analysis for ${tour || 'pga'} tour`);

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

    // Step 4: Get top 80 players by odds for detailed stats
    const topPlayerNames = oddsData.odds
      .sort((a, b) => a.odds - b.odds)
      .slice(0, 80)
      .map(o => o.player);
    
    console.log(`[AVOID] Fetching stats for top ${topPlayerNames.length} players by odds`);
    
    const statsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, {
      players: topPlayerNames
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

    // Step 6: Build player data - odds are already in American format
    const playersWithOdds = statsData.players
      .map(stat => {
        const oddsEntry = oddsData.odds.find(o => 
          normalizePlayerName(o.player) === normalizePlayerName(stat.player)
        );
        
        if (!oddsEntry) return null;
        
        return {
          player: stat.player,
          odds: oddsEntry.odds, // American odds
          minOdds: oddsEntry.minOdds, // Already in decimal
          maxOdds: oddsEntry.maxOdds, // Already in decimal
          bookmakerCount: oddsEntry.bookmakerCount || 0,
          stats: stat.stats
        };
      })
      .filter(p => p !== null && p.odds < 2000) // Under +2000 = short odds
      .sort((a, b) => a.odds - b.odds);

    console.log(`[AVOID] ${playersWithOdds.length} players with short odds (under +2000) for analysis`);

    if (playersWithOdds.length === 0) {
      console.log('[AVOID] No players with odds under +2000 found');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament: { name: tournament.name, course: tournament.course },
          avoidPicks: [],
          reasoning: 'No short odds players found in the field',
          generatedAt: new Date().toISOString()
        })
      };
    }

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
      courseInfo
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
 * Build prompt for avoid picks - using American odds
 */
function buildAvoidPicksPrompt(tournament, players, weather, courseInfo) {
  const formatAmericanOdds = (odds) => odds > 0 ? `+${odds}` : `${odds}`;
  
  const playerList = players.slice(0, 40).map(p => 
    `${p.player} [${formatAmericanOdds(p.odds)}] - R${p.stats.rank} | SG:${p.stats.sgTotal?.toFixed(2) || 'N/A'} (OTT:${p.stats.sgOTT?.toFixed(2) || 'N/A'} APP:${p.stats.sgAPP?.toFixed(2) || 'N/A'} ARG:${p.stats.sgARG?.toFixed(2) || 'N/A'} P:${p.stats.sgPutt?.toFixed(2) || 'N/A'})`
  ).join('\n');

  return `You are identifying players to AVOID - players with SHORT odds but POOR course fit.

TOURNAMENT: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

SHORT ODDS PLAYERS (sorted by odds, showing top 40):
${playerList}

YOUR TASK - FIND POOR COURSE FITS:
Identify exactly 3 players who should be AVOIDED because:
1. They have SHORT odds (market backing them - under +2000)
2. BUT their stats are WRONG for this course
3. Specific statistical WEAKNESSES that hurt them here

IMPORTANT: You are looking for MISMATCHES between player strengths and course demands!

EXAMPLES OF WHAT TO LOOK FOR:
❌ AVOID: Player has poor SG:APP (-0.3) but course has tiny greens requiring elite approach accuracy
❌ AVOID: Player ranks #120 in SG:OTT but course is 7,500 yards demanding elite distance
❌ AVOID: Player has weak SG:Putt on bentgrass but course has fast bentgrass greens

DO NOT pick players with good course fit! You are finding POOR fits only.

Return JSON with exactly 3 avoid picks:
{
  "reasoning": "What this course demands and why these specific player types will struggle (2-3 sentences)",
  "avoid": [
    {
      "player": "Player Name",
      "odds": 800,
      "reasoning": "SPECIFIC statistical weakness for THIS course. Example: 'Ranks #95 in SG:APP (-0.4) on a course demanding pinpoint iron play to small greens. His weak short game (#102 SG:ARG, -0.3) compounds the problem when missing greens. At +800, market ignores poor course fit.' Include actual stat rankings and values."
    }
  ]
}

Remember: Find players whose WEAKNESSES match this course's DEMANDS. Not players with good fits!`;
}
