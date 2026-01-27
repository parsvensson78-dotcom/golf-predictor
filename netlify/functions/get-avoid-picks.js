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
    console.log(`[AVOID] Tournament: ${tournament.name}`);

    // Step 2: Fetch stats for field (top 80 players only to save time)
    const playerNames = tournament.field.slice(0, 80).map(p => p.name);
    console.log(`[AVOID] Fetching stats for ${playerNames.length} players`);
    
    const statsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, {
      players: playerNames
    }, {
      timeout: 25000
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

    console.log(`[AVOID] Received odds for ${oddsData.odds.length} players`);

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
      console.error('[AVOID] Weather fetch failed:', weatherError.message);
    }

    // Step 5: Build player data with PROPER odds conversion
    const playersWithOdds = statsData.players
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
          console.log(`[AVOID] ${stat.player}: Avg ${decimalOdds.toFixed(1)} | Best ${decimalMinOdds?.toFixed(1)} | Worst ${decimalMaxOdds?.toFixed(1)}`);
        }
        
        return {
          player: stat.player,
          odds: decimalOdds, // Average odds in decimal format
          minOdds: decimalMinOdds, // Best odds for bettor
          maxOdds: decimalMaxOdds, // Worst odds for bettor
          americanOdds: oddsEntry?.americanOdds || null,
          bookmakerCount: oddsEntry?.bookmakerCount || 0,
          stats: stat.stats
        };
      })
      .filter(p => p.odds !== null && p.odds < 30) // Now correctly filters decimal odds under 30
      .sort((a, b) => a.odds - b.odds);

    console.log(`[AVOID] ${playersWithOdds.length} players with short odds (under 30/1) for analysis`);

    if (playersWithOdds.length === 0) {
      console.log('[AVOID] No players with odds under 30/1 found');
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

    // Step 6: Get course info
    const courseInfo = getCourseBasicInfo(tournament.course);

    // Step 7: Call Claude for avoid picks
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
      max_tokens: 2000,
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
      body: JSON.stringify({
        error: 'Failed to generate avoid picks',
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
 * Get basic course info
 */
function getCourseBasicInfo(courseName) {
  return {
    name: courseName,
    demands: ['To be analyzed from name and characteristics']
  };
}

/**
 * Build prompt for avoid picks
 */
function buildAvoidPicksPrompt(tournament, players, weather, courseInfo) {
  const playerList = players.slice(0, 30).map(p => 
    `${p.player} [${p.odds.toFixed(1)}] - Rank:${p.stats.rank} SG:Total:${p.stats.sgTotal} OTT:${p.stats.sgOTT} APP:${p.stats.sgAPP} ARG:${p.stats.sgARG} Putt:${p.stats.sgPutt}`
  ).join('\n');

  return `You are a professional golf analyst identifying players to AVOID betting on this week.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

FAVORITES & SHORT ODDS PLAYERS (decimal odds shown):
${playerList}

YOUR TASK:
Identify exactly 3 players with SHORT ODDS (under 30.0 decimal) who have POOR course fit and should be avoided.

CRITERIA FOR AVOID PICKS:
- Players with SHORT odds (market backing them)
- But their stats DON'T match this course demands
- Identify specific statistical weaknesses
- Explain why odds are too short given course fit

Return ONLY valid JSON (no markdown):
{
  "reasoning": "1-2 sentences explaining what this course demands and why certain player types will struggle",
  "avoid": [
    {
      "player": "Player Name",
      "odds": 18.0,
      "reasoning": "SPECIFIC mismatch: Explain why their stats are WRONG for this course. Include stat rankings showing poor fit. What weakness will hurt them? 2-3 sentences with numbers."
    },
    {
      "player": "Player Name",
      "odds": 22.0,
      "reasoning": "Another specific mismatch with stats"
    },
    {
      "player": "Player Name",
      "odds": 25.0,
      "reasoning": "Third mismatch"
    }
  ]
}

Focus on SPECIFIC stat mismatches. Example: "Ranks #89 in SG:APP (-0.4) on a course with tiny bentgrass greens demanding elite approach play. His #102 SG:Putt on poa annua (-0.6) creates double penalty. At 15.0 decimal odds, market ignoring course history stats."`;
}
