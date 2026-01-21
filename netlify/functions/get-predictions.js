const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Main prediction endpoint
 * Orchestrates data fetching and Claude AI analysis
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`Starting predictions for ${tour.toUpperCase()} tour`);

    // Step 1: Fetch tournament data
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;

    if (!tournament || !tournament.field || tournament.field.length === 0) {
      throw new Error('No tournament field data available');
    }

    console.log(`Tournament: ${tournament.name}, Field size: ${tournament.fieldSize}`);

    // Step 2: Fetch player stats for COMPLETE field
    const playerNames = tournament.field.map(p => p.name);
    console.log(`Fetching stats for ${playerNames.length} players`);
    
    const statsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, {
      players: playerNames
    }, {
      timeout: 30000 // Increased timeout for larger field
    });
    const statsData = statsResponse.data;

    // Step 3: Fetch odds for complete field
    const oddsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, {
      tournamentName: tournament.name,
      players: playerNames
    }, {
      timeout: 20000
    });
    const oddsData = oddsResponse.data;

    // Step 4: Get basic weather info (optional, simple)
    let weatherInfo = 'Weather data not available';
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const weatherResponse = await axios.get(`https://api.openweathermap.org/data/2.5/weather`, {
          params: {
            q: tournament.location.split(',')[0],
            appid: weatherApiKey,
            units: 'imperial'
          },
          timeout: 5000
        });
        
        if (weatherResponse.data) {
          weatherInfo = `${Math.round(weatherResponse.data.main.temp)}°F, ${weatherResponse.data.weather[0].description}, Wind: ${Math.round(weatherResponse.data.wind.speed)} mph`;
        }
      }
    } catch (weatherError) {
      console.log('Weather fetch failed:', weatherError.message);
    }

    // Step 5: Prepare COMPLETE field data for Claude
    const playersWithData = statsData.players
      .map(stat => {
        const odds = oddsData.odds.find(o => 
          o.player.toLowerCase() === stat.player.toLowerCase()
        );
        
        return {
          name: stat.player,
          rank: stat.stats.rank,
          odds: odds?.odds || null,
          sgTotal: stat.stats.sgTotal,
          sgOTT: stat.stats.sgOTT,
          sgAPP: stat.stats.sgAPP,
          sgARG: stat.stats.sgARG,
          sgPutt: stat.stats.sgPutt
        };
      })
      .filter(p => p.odds !== null && !p.notFound) // Only include players with odds and valid stats
      .sort((a, b) => (a.odds || 999) - (b.odds || 999)); // Sort by odds for better prompt organization

    console.log(`Analyzing complete field: ${playersWithData.length} players with valid data`);

    // Step 6: Call Claude API
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildClaudePrompt(tournament, playersWithData, weatherInfo);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000, // Increased for analyzing full field
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    
    // Parse JSON response from Claude
    let predictions;
    try {
      // Extract JSON from response (Claude might wrap it in markdown)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // Step 7: Return predictions with context
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=14400' // 4 hours
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
        predictions: predictions.picks || predictions,
        generatedAt: new Date().toISOString(),
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens
      })
    };

  } catch (error) {
    console.error('Prediction error:', error);
    
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
 * Builds optimized prompt for Claude - handles full field efficiently
 */
function buildClaudePrompt(tournament, players, weather) {
  // Split players into tiers for better context
  const favorites = players.slice(0, 15); // Top 15 by odds
  const midTier = players.slice(15, 50); // Mid-tier players
  const longshots = players.slice(50); // Long shots

  return `You are a professional golf analyst. Analyze this COMPLETE tournament field and identify exactly 3 players who offer the best VALUE picks based on their stats vs odds.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

COMPLETE FIELD (${players.length} players analyzed):

FAVORITES (odds 5-20):
${favorites.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

MID-TIER (odds 20-60):
${midTier.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

LONGSHOTS (odds 60+):
${longshots.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

ANALYSIS FRAMEWORK:
1. Course Fit: Which SG stats matter most for this course type?
2. Value Assessment: Who has stats suggesting they should have better odds?
3. Form: Current SG Total indicates recent performance
4. Balance: Consider picks from different tiers for portfolio approach

YOUR TASK:
Select 3 VALUE picks from across the ENTIRE field. Don't just pick favorites - find underpriced players where stats don't match odds. Look for:
- Mid-tier players with elite-level stats in key areas
- Longshots with surprisingly good course-fit metrics
- Anyone whose SG profile suggests mispriced odds

Return ONLY valid JSON (no markdown, no preamble):
{
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "2-3 concise sentences: why this player fits the course (specific SG stats) and why they're undervalued vs their odds"
    }
  ]
}

Keep reasoning under 60 words per pick. Be specific about numbers and course fit.`;
}
