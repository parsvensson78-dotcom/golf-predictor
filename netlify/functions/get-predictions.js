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

    // Step 4: Get weather info using WeatherAPI.com
    let weatherInfo = 'Weather data not available';
    let detailedWeather = null;
    
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        // Parse location - WeatherAPI is good with city names
        let location = tournament.location.split(',')[0].trim();
        
        // WeatherAPI.com uses a different endpoint structure
        console.log(`Fetching weather for: ${location} using WeatherAPI.com`);
        
        const weatherResponse = await axios.get(`https://api.weatherapi.com/v1/current.json`, {
          params: {
            key: weatherApiKey,
            q: location,
            aqi: 'no'
          },
          timeout: 8000
        });
        
        if (weatherResponse.data && weatherResponse.data.current) {
          const current = weatherResponse.data.current;
          const temp = Math.round(current.temp_f);
          const condition = current.condition.text;
          const windSpeed = Math.round(current.wind_mph);
          const humidity = current.humidity;
          
          weatherInfo = `${temp}°F, ${condition}, Wind: ${windSpeed}mph, Humidity: ${humidity}%`;
          
          detailedWeather = {
            temp,
            condition,
            windSpeed,
            humidity,
            impactLevel: windSpeed > 15 ? 'HIGH' : windSpeed > 10 ? 'MODERATE' : 'LOW'
          };
          
          console.log(`Weather fetched successfully: ${weatherInfo}`);
        }
      } else {
        console.log('Weather API key not configured');
        weatherInfo = 'Weather API key not configured';
      }
    } catch (weatherError) {
      console.error('Weather fetch failed:', weatherError.message);
      
      // Log more details for debugging
      if (weatherError.response) {
        console.error('Weather API response status:', weatherError.response.status);
        console.error('Weather API response data:', weatherError.response.data);
      }
      
      // More informative fallback messages
      if (weatherError.response?.status === 401) {
        weatherInfo = `Weather API key invalid - check your WeatherAPI.com key`;
      } else if (weatherError.response?.status === 400) {
        weatherInfo = `Location "${tournament.location}" not found by weather service`;
      } else {
        weatherInfo = `Weather unavailable (${weatherError.message})`;
      }
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

    // Step 7: Return predictions with context - NO CACHING
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
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
        courseAnalysis: {
          type: predictions.courseType || 'Analysis not available',
          weatherImpact: predictions.weatherImpact || 'No significant impact expected'
        },
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
 * Builds optimized prompt for Claude - focuses on VALUE and COURSE FIT
 */
function buildClaudePrompt(tournament, players, weather) {
  // Split players into tiers
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  return `You are a professional golf analyst specializing in finding VALUE picks based on course fit, NOT favorites.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

COMPLETE FIELD (${players.length} players):

TOP FAVORITES (odds 5-25) - GENERALLY AVOID UNLESS EXCEPTIONAL VALUE:
${favorites.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

MID-TIER VALUE ZONE (odds 25-100) - FOCUS HERE:
${midTier.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

LONGSHOTS (odds 100+) - CONSIDER IF COURSE FIT IS EXCELLENT:
${longshots.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

CRITICAL ANALYSIS FRAMEWORK:

1. COURSE TYPE IDENTIFICATION:
   - What type of course is this? (Links, parkland, desert, target golf, etc.)
   - What skills does THIS course reward most?
   - Examples:
     * Pebble Beach (links) = SG: OTT + ARG + Wind play
     * Augusta (target golf) = SG: APP + ARG + Distance
     * TPC Sawgrass (precision) = SG: APP + Putt + Strategy
     * Desert courses (Emirates, La Quinta) = SG: OTT + Ball striking

2. WEATHER IMPACT:
   - Current weather: ${weather}
   - How does this affect play? (wind = ball striking, rain = short game, etc.)
   - Which stats become MORE important in these conditions?

3. VALUE IDENTIFICATION - DO NOT PICK OBVIOUS FAVORITES:
   - Find players with ELITE course-fit stats but OVERLOOKED odds
   - Look for: Mid-tier players (odds 30-80) with top-10 stats in key areas
   - Example: Player ranked 40th with odds of 60-1 but #5 in SG: APP at a precision course = HUGE VALUE

4. AVOID:
   - Do NOT pick anyone with odds under 20 unless they have historically DOMINATED this course
   - Do NOT pick based on world ranking alone
   - Do NOT pick big names without course fit evidence

YOUR TASK:
Select exactly 3 VALUE picks where:
- At least 2 players should have odds ABOVE 30
- Players must have statistical evidence of course fit
- Focus on SPECIALISTS who excel in this course's required skills
- Consider weather conditions in your analysis

Return ONLY valid JSON (no markdown):
{
  "courseType": "Brief description of what this course rewards (e.g., 'Desert target golf requiring precise approach play and strong iron game')",
  "weatherImpact": "How weather affects play today (e.g., 'Light wind favors aggressive play, warm temps help ball flight')",
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "Specific course-fit analysis: which SG stats match this course, why they're undervalued, how weather helps them. 2-3 sentences max."
    }
  ]
}

Be specific with numbers. Example: "Ranks #3 in SG: APP (1.2) which is critical for this target-golf layout. At 55-1 odds despite elite approach play, he's severely underpriced for desert conditions."`;
}
