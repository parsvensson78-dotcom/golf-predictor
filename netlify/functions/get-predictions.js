const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

/**
 * Main prediction endpoint
 * Orchestrates data fetching and Claude AI analysis with course characteristics
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
      timeout: 30000
    });
    const statsData = statsResponse.data;

    // Step 3: Fetch odds for complete field
    const oddsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, {
      tournamentName: tournament.name,
      players: playerNames,
      tour: tournament.tour
    }, {
      timeout: 20000
    });
    const oddsData = oddsResponse.data;

    console.log(`[ODDS] Received odds for ${oddsData.odds.length} players from ${oddsData.source}`);
    
    // Debug: Check the structure of the first player from each source
    if (statsData.players && statsData.players.length > 0) {
      console.log(`[DEBUG] First player from stats:`, JSON.stringify(statsData.players[0]));
    }
    if (oddsData.odds && oddsData.odds.length > 0) {
      console.log(`[DEBUG] First player from odds:`, JSON.stringify(oddsData.odds[0]));
    }

    // Step 4: Get weather forecast using WeatherAPI.com
    let weatherInfo = 'Weather data not available';
    let dailyForecast = [];
    
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        let location = tournament.location.split(',')[0].trim();
        
        console.log(`Fetching 4-day weather forecast for: ${location} using WeatherAPI.com`);
        
        // Fetch 4-day forecast for tournament days (Thursday-Sunday)
        const weatherResponse = await axios.get(`https://api.weatherapi.com/v1/forecast.json`, {
          params: {
            key: weatherApiKey,
            q: location,
            days: 4,
            aqi: 'no'
          },
          timeout: 8000
        });
        
        if (weatherResponse.data && weatherResponse.data.forecast) {
          const forecast = weatherResponse.data.forecast.forecastday;
          
          // Process daily forecasts
          dailyForecast = forecast.map((day, index) => {
            const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
            const date = new Date(day.date);
            const dayName = index < 4 ? dayNames[index] : date.toLocaleDateString('en-US', { weekday: 'long' });
            
            return {
              day: dayName,
              date: day.date,
              tempHigh: Math.round(day.day.maxtemp_f),
              tempLow: Math.round(day.day.mintemp_f),
              condition: day.day.condition.text,
              windSpeed: Math.round(day.day.maxwind_mph),
              chanceOfRain: day.day.daily_chance_of_rain,
              humidity: day.day.avghumidity
            };
          });
          
          // Create summary for Claude's analysis
          const summaries = dailyForecast.map(d => 
            `${d.day}: ${d.tempHigh}°F, ${d.condition}, Wind: ${d.windSpeed}mph, Rain chance: ${d.chanceOfRain}%`
          );
          weatherInfo = summaries.join(' | ');
          
          // Calculate overall conditions
          const avgWind = Math.round(dailyForecast.reduce((sum, d) => sum + d.windSpeed, 0) / dailyForecast.length);
          const maxWind = Math.max(...dailyForecast.map(d => d.windSpeed));
          const highRainDays = dailyForecast.filter(d => d.chanceOfRain > 50).length;
          
          console.log(`Forecast fetched: Avg wind ${avgWind}mph, Max wind ${maxWind}mph, ${highRainDays} days with rain risk`);
        }
      } else {
        console.log('Weather API key not configured');
        weatherInfo = 'Weather API key not configured';
      }
    } catch (weatherError) {
      console.error('Weather fetch failed:', weatherError.message);
      
      if (weatherError.response) {
        console.error('Weather API response status:', weatherError.response.status);
        console.error('Weather API response data:', weatherError.response.data);
      }
      
      if (weatherError.response?.status === 401) {
        weatherInfo = `Weather API key invalid - check your WeatherAPI.com key`;
      } else if (weatherError.response?.status === 400) {
        weatherInfo = `Location "${tournament.location}" not found by weather service`;
      } else {
        weatherInfo = `Weather unavailable (${weatherError.message})`;
      }
    }

    // Step 5: Get course info from DataGolf
    const courseResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour}&tournament=${encodeURIComponent(tournament.name)}`, {
      timeout: 10000
    });
    const courseInfo = courseResponse.data;
    console.log('Course info fetched:', courseInfo.courseName || courseInfo.eventName);

    // Step 6: Prepare COMPLETE field data for Claude
    const playersWithData = statsData.players
      .map(stat => {
        const oddsEntry = oddsData.odds.find(o => 
          normalizePlayerName(o.player) === normalizePlayerName(stat.player)
        );
        
        // Convert average odds to decimal (minOdds and maxOdds already converted in fetch-odds)
        const decimalOdds = oddsEntry?.odds ? americanToDecimal(oddsEntry.odds) : null;
        
        if (decimalOdds) {
          console.log(`[ODDS] ${stat.player}: Avg ${decimalOdds.toFixed(1)} | Best ${oddsEntry?.minOdds?.toFixed(1)} (${oddsEntry?.bestBookmaker}) | Worst ${oddsEntry?.maxOdds?.toFixed(1)} (${oddsEntry?.worstBookmaker})`);
        } else {
          console.log(`[ODDS] ${stat.player}: NO MATCH FOUND`);
        }
        
        return {
          name: stat.player,
          rank: stat.stats.rank,
          odds: decimalOdds,  // Average odds in decimal
          minOdds: oddsEntry?.minOdds || null,  // Best odds (already decimal from fetch-odds)
          maxOdds: oddsEntry?.maxOdds || null,  // Worst odds (already decimal from fetch-odds)
          bestBookmaker: oddsEntry?.bestBookmaker || null,
          worstBookmaker: oddsEntry?.worstBookmaker || null,
          bookmakerCount: oddsEntry?.bookmakerCount || 0,
          sgTotal: stat.stats.sgTotal,
          sgOTT: stat.stats.sgOTT,
          sgAPP: stat.stats.sgAPP,
          sgARG: stat.stats.sgARG,
          sgPutt: stat.stats.sgPutt
        };
      })
      .filter(p => p.odds !== null && !p.notFound)
      .sort((a, b) => (a.odds || 999) - (b.odds || 999));

    console.log(`Analyzing complete field: ${playersWithData.length} players with valid data`);
    
    // Step 7: Call Claude API with course info
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildClaudePrompt(tournament, playersWithData, weatherInfo, courseInfo);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.3,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    console.log('[CLAUDE] Response length:', responseText.length);
    console.log('[CLAUDE] First 200 chars:', responseText.substring(0, 200));
    console.log('[CLAUDE] Last 200 chars:', responseText.substring(responseText.length - 200));
    
    // Parse JSON response from Claude
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[CLAUDE] No JSON found in response');
        throw new Error('No JSON found in AI response');
      }
      console.log('[CLAUDE] JSON match length:', jsonMatch[0].length);
      predictions = JSON.parse(jsonMatch[0]);
      console.log('[CLAUDE] Successfully parsed predictions with', predictions.picks?.length, 'picks');
    } catch (parseError) {
      console.error('[CLAUDE] Failed to parse response:', parseError.message);
      console.error('[CLAUDE] Full response text:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // ENRICH predictions with odds breakdown data from DataGolf
    if (predictions.picks && Array.isArray(predictions.picks)) {
      predictions.picks = predictions.picks.map(pick => {
        const playerData = playersWithData.find(p => 
          normalizePlayerName(p.name) === normalizePlayerName(pick.player)
        );
        
        if (playerData) {
          return {
            ...pick,
            minOdds: playerData.minOdds,
            maxOdds: playerData.maxOdds,
            bestBookmaker: playerData.bestBookmaker,
            worstBookmaker: playerData.worstBookmaker
          };
        }
        return pick;
      });
    }

    // Calculate cost based on Claude Sonnet 4 pricing
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const inputCost = (inputTokens / 1000000) * 3.00;  // $3 per million input tokens
    const outputCost = (outputTokens / 1000000) * 15.00; // $15 per million output tokens
    const totalCost = inputCost + outputCost;

    // Step 8: Return predictions with course info
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
        dailyForecast: dailyForecast,
        courseInfo: {
          name: courseInfo.courseName || courseInfo.eventName,
          courseName: courseInfo.courseName,
          courseKey: courseInfo.courseKey,
          location: courseInfo.location,
          city: courseInfo.city,
          state: courseInfo.state,
          country: courseInfo.country,
          par: courseInfo.par,
          yardage: courseInfo.yardage,
          eventId: courseInfo.eventId,
          status: courseInfo.status,
          winner: courseInfo.winner,
          source: courseInfo.source
        },
        courseAnalysis: {
          type: predictions.courseType || 'Analysis not available',
          weatherImpact: predictions.weatherImpact || 'No significant impact expected',
          keyFactors: predictions.keyFactors || [],
          notes: predictions.courseNotes || ''
        },
        predictions: predictions.picks || predictions,
        generatedAt: new Date().toISOString(),
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
        tokenBreakdown: {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens
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
 * Convert American odds to decimal odds
 * American: +1800 → Decimal: 19.0 → Fractional: 18/1
 * American: -200 → Decimal: 1.5 → Fractional: 1/2
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
 * Handles both "LastName, FirstName" and "FirstName LastName" formats
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
 * Builds optimized prompt for Claude with course info from DataGolf
 */
function buildClaudePrompt(tournament, players, weather, courseInfo) {
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  return `You are a professional golf analyst specializing in finding VALUE picks based on course fit, NOT favorites.

TOURNAMENT:
Name: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName}
Location: ${courseInfo.location}${courseInfo.city ? ` (${courseInfo.city}${courseInfo.state ? ', ' + courseInfo.state : ''})` : ''}
Weather: ${weather}

COURSE INFORMATION FROM DATAGOLF:
${courseInfo.par ? `Par: ${courseInfo.par}` : 'Par: Unknown (research required)'}
${courseInfo.yardage ? `Yardage: ${courseInfo.yardage} yards` : 'Yardage: Unknown (research required)'}
Course Name: ${courseInfo.courseName || courseInfo.eventName}
Course Key: ${courseInfo.courseKey || 'N/A'}
${courseInfo.winner ? `Previous Winner: ${courseInfo.winner}` : ''}

COURSE ANALYSIS REQUIRED:
Based on the course data above for "${courseInfo.courseName || courseInfo.eventName}" and location "${courseInfo.location}", analyze:

1. COURSE CHARACTERISTICS:
   ${courseInfo.yardage && courseInfo.par ? `- Confirmed: ${courseInfo.yardage} yards, Par ${courseInfo.par}` : '- Research expected yardage and par for this specific course'}
   - Fairway width (narrow/moderate/wide)
   - Green size and firmness
   - Rough type and severity
   - Key hazards (water, bunkers, etc.)

2. SKILLS REWARDED:
   - What does THIS specific course reward?
   ${courseInfo.yardage ? (courseInfo.yardage > 7500 ? '- Long course likely requiring distance (SG:OTT)' : courseInfo.yardage < 7200 ? '- Shorter course favoring accuracy over distance' : '- Balanced length requiring complete game') : '- Determine if distance or accuracy is more important'}
   - Does it have small greens requiring approach precision (SG:APP)?
   - Is there heavy rough demanding scrambling (SG:ARG)?
   - Are the greens particularly challenging (SG:Putt)?

3. HISTORICAL CONTEXT:
   ${courseInfo.winner ? `- Previous winner: ${courseInfo.winner} - what are their strengths?` : '- What types of players have succeeded here before?'}
   - Are there any course-specific factors (elevation, wind, coastal, etc.)?

Use your knowledge of professional golf courses${courseInfo.courseName ? ` and specifically ${courseInfo.courseName}` : ''} to provide SPECIFIC analysis.

COMPLETE FIELD (${players.length} players):

TOP FAVORITES (odds 5-20) - SKIP THESE - TOO SHORT FOR VALUE:
${favorites.map(p => `${p.name} [${p.odds?.toFixed(1)}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

VALUE ZONE (odds 20-100) - FOCUS HERE FOR MOST PICKS:
${midTier.map(p => `${p.name} [${p.odds?.toFixed(1)}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

LONGSHOTS (odds 100+) - CONSIDER 1-2 IF COURSE FIT IS EXCEPTIONAL:
${longshots.map(p => `${p.name} [${p.odds?.toFixed(1)}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

CRITICAL ANALYSIS FRAMEWORK:

1. COURSE TYPE IDENTIFICATION:
   - Research and identify the specific characteristics of ${courseInfo.courseName || courseInfo.eventName}
   ${courseInfo.yardage ? `- Known length: ${courseInfo.yardage} yards ${courseInfo.par ? `(Par ${courseInfo.par})` : ''}` : '- Determine course length'}
   ${courseInfo.yardage && courseInfo.yardage > 7500 ? '- Long course: Distance (SG:OTT) is CRITICAL' : courseInfo.yardage && courseInfo.yardage < 7200 ? '- Shorter course: Accuracy and iron play MORE important than distance' : '- Analyze what skills matter most'}
   - Analyze fairway width and its impact on driving strategy
   - Consider green characteristics and putting demands
   - Evaluate rough severity and scrambling requirements

2. WEATHER IMPACT:
   - Current weather: ${weather}
   - How does this affect play at THIS specific course?
   - Wind + narrow fairways = Accuracy premium
   - Wind + coastal = Ball flight control essential
   - Rain + long course = Even more distance advantage

3. VALUE IDENTIFICATION - MATCH STATS TO COURSE NEEDS:
   - Find players whose STRENGTHS align with what THIS COURSE rewards
   - Match their SG strengths to the specific course demands you identified
   - Look for players with odds 30-80 who excel in the 2-3 most important categories for THIS course

4. AVOID:
   - Do NOT pick anyone with odds under 20/1 - we're looking for VALUE, not favorites
   - Do NOT ignore course-specific requirements
   - Do NOT pick players whose strengths don't match this course
   - Do NOT pick based on world ranking alone
   - Do NOT pick big-name players just because they're popular - focus on course fit

YOUR TASK:
Select exactly 6 VALUE picks where:
- ALL players should have odds of 20/1 or higher
- At least 4 players should have odds ABOVE 40/1
- Players must have statistical evidence they excel at THIS COURSE TYPE
- Match their SG strengths to your analyzed course characteristics
- Consider weather conditions in your analysis
- Provide a range of odds: some at 20-40/1 (shorter value), some at 40-80/1 (mid-range value), and some at 80-150/1 (longshots)

Return ONLY valid JSON (no markdown):
{
  "courseType": "Detailed description of ${courseInfo.courseName || courseInfo.eventName}${courseInfo.yardage && courseInfo.par ? `: ${courseInfo.yardage} yards, Par ${courseInfo.par}` : ''}, what skills it rewards, why (e.g., '7765-yard Par 72 test of power requiring elite distance off tee, with heavy rough demanding strong scrambling')",
  "weatherImpact": "How today's weather (${weather}) affects strategy and which skills become more important at this specific course",
  "keyFactors": ["List 3-4 specific course factors", "that determine success", "based on your analysis of ${courseInfo.courseName || courseInfo.eventName}"],
  "courseNotes": "2-3 detailed sentences explaining ${courseInfo.courseName || courseInfo.eventName} setup. ${courseInfo.yardage && courseInfo.par ? `At ${courseInfo.yardage} yards and Par ${courseInfo.par}, ` : 'Include specific details about par and length, '}what makes this course unique, and how these factors create betting value. Example: 'At 7,300 yards and par 72, this Pete Dye design features narrow, tree-lined fairways and small, elevated greens. The course heavily penalizes wayward tee shots, making accuracy far more valuable than distance. Players who excel in approach play (high SG:APP) and scrambling (high SG:ARG) have a massive edge that the betting market consistently undervalues.'",
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "SPECIFIC course-fit analysis: Match their SG stats to the exact course demands you identified for ${courseInfo.courseName || courseInfo.eventName}. Explain why they're undervalued given these characteristics. Include numbers. 2-3 sentences max."
    }
  ]
}

Be specific with course-stat matchups and use your knowledge of ${courseInfo.courseName || courseInfo.eventName} to provide accurate analysis.`;
}
