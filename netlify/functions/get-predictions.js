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
        let location = tournament.location.split(',')[0].trim();
        
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

    // Step 5: Get detailed course characteristics
    const courseInfo = await getCourseCharacteristics(tournament.course, tournament.name);
    console.log('Course characteristics fetched:', courseInfo.name);

    // Step 6: Prepare COMPLETE field data for Claude
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
      .filter(p => p.odds !== null && !p.notFound)
      .sort((a, b) => (a.odds || 999) - (b.odds || 999));

    console.log(`Analyzing complete field: ${playersWithData.length} players with valid data`);

    // Step 7: Call Claude API with enhanced course info
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildClaudePrompt(tournament, playersWithData, weatherInfo, courseInfo);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3500,
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
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
    }

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
        courseInfo: courseInfo,
        courseAnalysis: {
          type: predictions.courseType || 'Analysis not available',
          weatherImpact: predictions.weatherImpact || 'No significant impact expected',
          keyFactors: predictions.keyFactors || [],
          notes: predictions.courseNotes || ''
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
 * Get detailed course characteristics based on course name
 * This uses known course data and Claude's knowledge
 */
async function getCourseCharacteristics(courseName, tournamentName) {
  // Known course database - add more as needed
  const knownCourses = {
    'Pebble Beach': {
      name: 'Pebble Beach Golf Links',
      yardage: 7075,
      par: 72,
      width: 'Narrow fairways with coastal cliffs',
      greens: 'Small, Poa annua greens',
      rough: 'Heavy kikuyu rough',
      keyFeatures: ['Iconic coastal holes', 'Wind is critical factor', 'Short game demands high', 'Poa annua putting'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Scrambling ability', 'Wind management', 'Short game excellence'],
      avgScore: 72.5
    },
    'TPC Sawgrass': {
      name: 'TPC Sawgrass (Stadium Course)',
      yardage: 7256,
      par: 72,
      width: 'Narrow, target-style fairways',
      greens: 'Firm, fast Bermuda greens',
      rough: 'Bermuda rough with waste areas',
      keyFeatures: ['Island 17th green', 'Water hazards on 10+ holes', 'Strategic bunkering', 'Stadium atmosphere'],
      difficulty: 'Extremely difficult',
      rewards: ['Iron precision', 'Course management', 'Mental toughness', 'Ball striking'],
      avgScore: 72.2
    },
    'Augusta National': {
      name: 'Augusta National Golf Club',
      yardage: 7510,
      par: 72,
      width: 'Moderate width with strategic positioning',
      greens: 'Exceptionally fast, undulating bentgrass',
      rough: 'Light rough, pine straw',
      keyFeatures: ['Extreme green slopes', 'Amen Corner', 'Second-shot golf course', 'Fast, firm conditions'],
      difficulty: 'Very difficult',
      rewards: ['Distance and trajectory control', 'Iron play', 'Green reading', 'Mental game'],
      avgScore: 71.8
    },
    'Torrey Pines': {
      name: 'Torrey Pines Golf Course (South)',
      yardage: 7765,
      par: 72,
      width: 'Moderate width, coastal terrain',
      greens: 'Poa annua, can be bumpy',
      rough: 'Heavy kikuyu rough',
      keyFeatures: ['Longest course on tour', 'Coastal winds', 'Kikuyu rough is penal', 'Public course'],
      difficulty: 'Very difficult',
      rewards: ['Distance critical', 'Power off tee', 'Scrambling from kikuyu', 'Wind play'],
      avgScore: 73.1
    }
  };

  // Check if we have detailed info for this course
  for (const [key, data] of Object.entries(knownCourses)) {
    if (courseName.toLowerCase().includes(key.toLowerCase())) {
      return data;
    }
  }

  // For unknown courses, return a template that Claude will fill in with analysis
  return {
    name: courseName,
    yardage: null,
    par: 72,
    width: 'Unknown - will be analyzed',
    greens: 'Unknown - will be analyzed',
    rough: 'Unknown - will be analyzed',
    keyFeatures: [],
    difficulty: 'Unknown',
    rewards: ['Will be determined by analysis'],
    avgScore: null
  };
}

/**
 * Builds optimized prompt for Claude with COURSE CHARACTERISTICS
 */
function buildClaudePrompt(tournament, players, weather, courseInfo) {
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  return `You are a professional golf analyst specializing in finding VALUE picks based on course fit, NOT favorites.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

DETAILED COURSE CHARACTERISTICS:
${courseInfo.yardage ? `Length: ${courseInfo.yardage} yards, Par ${courseInfo.par}` : 'Length: Research needed'}
Width: ${courseInfo.width}
Greens: ${courseInfo.greens}
Rough: ${courseInfo.rough}
${courseInfo.avgScore ? `Tour Average Score: ${courseInfo.avgScore}` : ''}

Key Course Features:
${courseInfo.keyFeatures.length > 0 ? courseInfo.keyFeatures.map(f => `- ${f}`).join('\n') : '- Analyze from tournament name and location'}

Skills This Course Rewards:
${courseInfo.rewards.length > 0 ? courseInfo.rewards.map(r => `- ${r}`).join('\n') : '- Determine from course type'}

COMPLETE FIELD (${players.length} players):

TOP FAVORITES (odds 5-25) - GENERALLY AVOID UNLESS EXCEPTIONAL VALUE:
${favorites.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

MID-TIER VALUE ZONE (odds 25-100) - FOCUS HERE:
${midTier.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

LONGSHOTS (odds 100+) - CONSIDER IF COURSE FIT IS EXCELLENT:
${longshots.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

CRITICAL ANALYSIS FRAMEWORK:

1. COURSE TYPE IDENTIFICATION:
   - Based on the course characteristics above, what skills are MOST important?
   - If course length is ${courseInfo.yardage || 'unknown'} yards:
     * <7200 yards = Accuracy and iron play over distance
     * 7200-7500 yards = Balanced, but distance helps
     * >7500 yards = Distance critical, SG:OTT becomes vital
   - Fairway width: ${courseInfo.width}
     * Narrow = SG:OTT accuracy crucial
     * Wide = Aggressive play, distance advantage
   - Green characteristics: ${courseInfo.greens}
     * Small greens = SG:APP precision critical
     * Fast/undulating = SG:Putt becomes more important
     * Poa annua = Experience on Poa helps
   - Rough: ${courseInfo.rough}
     * Heavy rough (kikuyu, etc.) = SG:ARG critical for recovery
     * Light rough = Less penalty for misses

2. WEATHER IMPACT:
   - Current weather: ${weather}
   - How does this affect play based on course characteristics?
   - Wind + narrow fairways = Accuracy premium
   - Wind + coastal = Ball flight control essential
   - Rain + long course = Even more distance advantage

3. VALUE IDENTIFICATION - MATCH STATS TO COURSE NEEDS:
   - Find players whose STRENGTHS align with what THIS COURSE rewards
   - Example: If course is 7800 yards with heavy rough:
     * Look for elite SG:OTT (distance + accuracy)
     * Look for strong SG:ARG (recovery ability)
     * De-emphasize SG:Putt if greens are straightforward
   - Find players with odds 30-80 who have top-tier stats in the 2-3 most important categories

4. AVOID:
   - Do NOT pick anyone with odds under 20 unless historically dominant here
   - Do NOT ignore course length - distance matters on long tracks
   - Do NOT pick players whose strengths don't match course demands
   - Do NOT pick based on world ranking alone

YOUR TASK:
Select exactly 5 VALUE picks where:
- At least 3 players should have odds ABOVE 30
- Players must have statistical evidence they excel at THIS COURSE TYPE
- Match their SG strengths to the specific course characteristics listed above
- Consider weather conditions in your analysis
- Provide a range of odds - include some mid-tier (30-60) and some longshots (60-150)

Return ONLY valid JSON (no markdown):
{
  "courseType": "Detailed description: length, what skills it rewards, why (e.g., '7765-yard test of power requiring elite distance off tee, with heavy kikuyu rough demanding strong scrambling')",
  "weatherImpact": "How today's weather (${weather}) affects strategy and which skills become more important",
  "keyFactors": ["List 3-4 specific course factors", "that determine success", "based on the characteristics above"],
  "courseNotes": "2-3 detailed sentences explaining the course setup. Include specific details about par, length, what makes this course unique, and how these factors create betting value. Example: 'At 7,075 yards and par 72, Pebble Beach plays shorter than most tour stops but the coastal winds and small poa annua greens create extreme difficulty. The dramatic 200+ yard scoring variance between calm and windy days makes scrambling ability far more valuable than distance. Players who excel in kikuyu rough recovery (high SG:ARG) have a massive edge that the betting market consistently undervalues.'",
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "SPECIFIC course-fit analysis: Match their SG stats to the exact course demands (length, greens, rough, etc.). Explain why they're undervalued given these characteristics. Include numbers. 2-3 sentences max."
    }
  ]
}

Be specific with course-stat matchups. Example: "At 7765 yards, this course demands distance. Ranks #2 in SG:OTT (1.4) and #8 in SG:ARG (0.8) - perfect for the heavy kikuyu rough. At 60-1 odds despite being built for this track, massive value."`;
}
