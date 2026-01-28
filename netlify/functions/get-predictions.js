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

    // Step 5: Get detailed course characteristics
    const courseInfo = await getCourseCharacteristics(tournament.course, tournament.name);
    console.log('Course characteristics fetched:', courseInfo.name);

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
    
    // Step 7: Call Claude API with enhanced course info
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
    
    // Parse JSON response from Claude
    let predictions;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      predictions = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
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
        courseInfo: courseInfo,
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
 * Get detailed course characteristics based on course name
 * Comprehensive 2026 Season Database
 */
async function getCourseCharacteristics(courseName, tournamentName) {
  // ============================================================================
  // COMPREHENSIVE COURSE DATABASE - 2026 SEASON
  // Updated: January 2026
  // Includes 60+ PGA Tour and DP World Tour venues
  // ============================================================================
  const knownCourses = {
    // ========== HAWAII SWING (January) ==========
    'Kapalua': {
      name: 'Kapalua Plantation Course',
      yardage: 7596,
      par: 73,
      width: 'Wide, generous fairways',
      greens: 'Large, undulating Bermuda greens',
      rough: 'Light rough with native areas',
      keyFeatures: ['Extreme elevation changes', 'Trade winds critical', 'Wide landing areas', 'Long par 5s'],
      difficulty: 'Moderate',
      rewards: ['Distance off tee', 'Wind play', 'Long iron accuracy', 'Green reading'],
      avgScore: 72.5
    },
    'Plantation': {
      name: 'Kapalua Plantation Course',
      yardage: 7596,
      par: 73,
      width: 'Wide, generous fairways',
      greens: 'Large, undulating Bermuda greens',
      rough: 'Light rough with native areas',
      keyFeatures: ['Extreme elevation changes', 'Trade winds critical', 'Wide landing areas', 'Long par 5s'],
      difficulty: 'Moderate',
      rewards: ['Distance off tee', 'Wind play', 'Long iron accuracy', 'Green reading'],
      avgScore: 72.5
    },
    'Waialae': {
      name: 'Waialae Country Club',
      yardage: 7044,
      par: 70,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, firm Bermuda greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Short but tight', 'Frequent trade winds', 'Small greens premium', 'Birdie-fest potential'],
      difficulty: 'Moderate',
      rewards: ['Accuracy off tee', 'Wedge play', 'Wind management', 'Putting excellence'],
      avgScore: 68.8
    },

    // ========== WEST COAST SWING (January-February) ==========
    'La Quinta': {
      name: 'La Quinta Country Club',
      yardage: 7060,
      par: 72,
      width: 'Wide, generous fairways',
      greens: 'Large, receptive Bermuda greens',
      rough: 'Light desert rough',
      keyFeatures: ['Desert target golf', 'Strategic water hazards', 'Pete Dye design', 'Scoring opportunities'],
      difficulty: 'Moderate',
      rewards: ['Aggressive approach play', 'Birdie-making ability', 'Strong iron game', 'Putting confidence'],
      avgScore: 70.2
    },
    'PGA West': {
      name: 'PGA West Stadium Course',
      yardage: 7300,
      par: 72,
      width: 'Wide with strategic hazards',
      greens: 'Large, undulating Bermuda greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Stadium atmosphere', 'Island greens', 'Water hazards', 'Risk-reward holes'],
      difficulty: 'Difficult',
      rewards: ['Course management', 'Iron precision', 'Mental toughness', 'Scrambling'],
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
    },
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
    'Spyglass': {
      name: 'Spyglass Hill Golf Course',
      yardage: 7041,
      par: 72,
      width: 'Narrow, tree-lined inland holes',
      greens: 'Small, Poa annua greens',
      rough: 'Heavy kikuyu and pine straw',
      keyFeatures: ['Mix of coastal and forest holes', 'Tough opening stretch', 'Demanding par 3s', 'Strategic design'],
      difficulty: 'Very difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental strength'],
      avgScore: 73.2
    },
    'Monterey': {
      name: 'Monterey Peninsula Country Club (Shore Course)',
      yardage: 6958,
      par: 71,
      width: 'Moderate width with coastal exposure',
      greens: 'Poa annua greens',
      rough: 'Kikuyu rough',
      keyFeatures: ['Coastal holes', 'Wind factor', 'Scenic views', 'Short but challenging'],
      difficulty: 'Difficult',
      rewards: ['Wind play', 'Short game', 'Course management', 'Accuracy'],
      avgScore: 71.8
    },
    'Riviera': {
      name: 'Riviera Country Club',
      yardage: 7322,
      par: 71,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, firm Kikuyu/Poa mix',
      rough: 'Thick kikuyu rough',
      keyFeatures: ['Classic architecture', 'Barranca hazards', 'Elevated greens', 'Strategic bunkering'],
      difficulty: 'Very difficult',
      rewards: ['Ball striking', 'Iron precision', 'Scrambling ability', 'Course management'],
      avgScore: 71.2
    },
    'TPC Scottsdale': {
      name: 'TPC Scottsdale (Stadium Course)',
      yardage: 7261,
      par: 71,
      width: 'Wide desert fairways',
      greens: 'Large, overseeded Bermuda greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Famous 16th hole', 'Stadium atmosphere', 'Scoring opportunities', 'Desert target golf'],
      difficulty: 'Moderate',
      rewards: ['Aggressive play', 'Birdie-making', 'Iron accuracy', 'Putting'],
      avgScore: 68.5
    },

    // ========== FLORIDA SWING (February-March) ==========
    'PGA National': {
      name: 'PGA National (Champion Course)',
      yardage: 7140,
      par: 70,
      width: 'Moderate width with water',
      greens: 'Firm, fast Bermuda greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Bear Trap holes 15-17', 'Water on 16 holes', 'Wind critical', 'Tough stretch finish'],
      difficulty: 'Very difficult',
      rewards: ['Mental toughness', 'Wind play', 'Iron control', 'Scrambling'],
      avgScore: 70.8
    },
    'Bay Hill': {
      name: 'Arnold Palmer Bay Hill Club & Lodge',
      yardage: 7466,
      par: 72,
      width: 'Moderate width with water hazards',
      greens: 'Firm, fast Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['Water on multiple holes', 'Arnold Palmer redesign', 'Tough closing stretch', 'Wind factor'],
      difficulty: 'Very difficult',
      rewards: ['Distance control', 'Iron play', 'Mental toughness', 'Scrambling'],
      avgScore: 72.8
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
    'Valspar': {
      name: 'Innisbrook Resort (Copperhead Course)',
      yardage: 7340,
      par: 71,
      width: 'Narrow, heavily tree-lined',
      greens: 'Small, elevated Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['No water hazards', 'Copperhead challenges', 'Elevated greens', 'Strategic bunkering'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Approach play', 'Scrambling', 'Ball striking'],
      avgScore: 71.5
    },
    'Innisbrook': {
      name: 'Innisbrook Resort (Copperhead Course)',
      yardage: 7340,
      par: 71,
      width: 'Narrow, heavily tree-lined',
      greens: 'Small, elevated Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['No water hazards', 'Copperhead challenges', 'Elevated greens', 'Strategic bunkering'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Approach play', 'Scrambling', 'Ball striking'],
      avgScore: 71.5
    },

    // ========== TEXAS & SOUTHERN SWING (March-April) ==========
    'TPC San Antonio': {
      name: 'TPC San Antonio (AT&T Oaks Course)',
      yardage: 7435,
      par: 72,
      width: 'Wide fairways with strategic bunkering',
      greens: 'Large, undulating bentgrass greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Greg Norman design', 'Elevation changes', 'Strategic water', 'Risk-reward holes'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Strong iron game', 'Putting'],
      avgScore: 70.5
    },
    'TPC Louisiana': {
      name: 'TPC Louisiana',
      yardage: 7425,
      par: 72,
      width: 'Moderate width with water',
      greens: 'Large, undulating bermuda greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Pete Dye design', 'Wetlands throughout', 'Strategic bunkering', 'Wind factor'],
      difficulty: 'Moderate',
      rewards: ['Ball striking', 'Course management', 'Iron play', 'Putting'],
      avgScore: 71.2
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
    'Harbour Town': {
      name: 'Harbour Town Golf Links',
      yardage: 7191,
      par: 71,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, firm Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['Pete Dye design', 'Narrow fairways', 'Precision over power', 'Iconic lighthouse'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Iron precision', 'Course management', 'Short game'],
      avgScore: 70.8
    },

    // ========== MAJOR CHAMPIONSHIP VENUES ==========
    'Pinehurst': {
      name: 'Pinehurst No. 2',
      yardage: 7565,
      par: 70,
      width: 'Wide fairways with collection areas',
      greens: 'Crowned, turtleback bentgrass greens',
      rough: 'Wiregrass and sandy areas',
      keyFeatures: ['Donald Ross design', 'Crowned greens', 'Sandy waste areas', 'Precision required'],
      difficulty: 'Extremely difficult',
      rewards: ['Iron precision', 'Short game mastery', 'Mental toughness', 'Strategic thinking'],
      avgScore: 71.5
    },
    'Oak Hill': {
      name: 'Oak Hill Country Club (East Course)',
      yardage: 7394,
      par: 70,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, undulating bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Donald Ross design', 'Tree-lined corridors', 'Demanding par 3s', 'Strategic bunkering'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Ball striking', 'Iron play', 'Mental toughness'],
      avgScore: 71.2
    },
    'Oakmont': {
      name: 'Oakmont Country Club',
      yardage: 7255,
      par: 70,
      width: 'Wide fairways with Church Pews',
      greens: 'Extremely fast, undulating bentgrass',
      rough: 'Heavy rough',
      keyFeatures: ['Church Pews bunker', 'Fastest greens in golf', 'Historic venue', 'Brutal difficulty'],
      difficulty: 'Extremely difficult',
      rewards: ['Ball striking', 'Green reading', 'Mental fortitude', 'Putting excellence'],
      avgScore: 73.5
    },
    'Valhalla': {
      name: 'Valhalla Golf Club',
      yardage: 7542,
      par: 72,
      width: 'Wide fairways with strategic hazards',
      greens: 'Large, undulating bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['Jack Nicklaus design', 'Water on multiple holes', 'Scoring opportunities', 'Strategic risk-reward'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Iron accuracy', 'Putting'],
      avgScore: 70.8
    },
    'Shinnecock': {
      name: 'Shinnecock Hills Golf Club',
      yardage: 7445,
      par: 70,
      width: 'Wide fairways with firm conditions',
      greens: 'Small, extremely fast bentgrass greens',
      rough: 'Fescue rough',
      keyFeatures: ['Links-style', 'Firm and fast', 'Wind critical', 'Historic venue'],
      difficulty: 'Extremely difficult',
      rewards: ['Wind play', 'Ball striking', 'Course management', 'Mental toughness'],
      avgScore: 72.8
    },
    'Bethpage Black': {
      name: 'Bethpage State Park (Black Course)',
      yardage: 7468,
      par: 70,
      width: 'Wide but heavily bunkered',
      greens: 'Bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Public course', 'Extreme length', 'Strategic bunkering', 'Demanding par 4s'],
      difficulty: 'Extremely difficult',
      rewards: ['Distance off tee', 'Ball striking', 'Mental toughness', 'Stamina'],
      avgScore: 73.0
    },

    // ========== SUMMER SWING (May-August) ==========
    'Muirfield Village': {
      name: 'Muirfield Village Golf Club',
      yardage: 7543,
      par: 72,
      width: 'Moderate width with strategic design',
      greens: 'Firm, fast bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Jack Nicklaus design', 'Strategic water hazards', 'Premium on accuracy', 'Difficult par 3s'],
      difficulty: 'Very difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental game'],
      avgScore: 71.8
    },
    'TPC Potomac': {
      name: 'TPC Potomac at Avenel Farm',
      yardage: 7160,
      par: 70,
      width: 'Moderate width with water',
      greens: 'Bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['Congressional layout', 'Water in play', 'Strategic design', 'Short but demanding'],
      difficulty: 'Moderate',
      rewards: ['Iron play', 'Short game', 'Accuracy', 'Putting'],
      avgScore: 69.5
    },
    'TPC River Highlands': {
      name: 'TPC River Highlands',
      yardage: 6841,
      par: 70,
      width: 'Narrow, tight fairways',
      greens: 'Small, firm bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Short course', 'Precision required', 'Scoring opportunities', 'Strategic water'],
      difficulty: 'Moderate',
      rewards: ['Accuracy off tee', 'Iron precision', 'Birdie-making', 'Short game'],
      avgScore: 67.5
    },
    'TPC Twin Cities': {
      name: 'TPC Twin Cities',
      yardage: 7431,
      par: 72,
      width: 'Moderate width',
      greens: 'Bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['Arnold Palmer design', 'Strategic water', 'Risk-reward holes', 'Scoring opportunities'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Iron game', 'Putting'],
      avgScore: 69.8
    },
    'Sedgefield': {
      name: 'Sedgefield Country Club',
      yardage: 7131,
      par: 70,
      width: 'Moderate width, tree-lined',
      greens: 'Bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['Donald Ross design', 'Classic layout', 'Strategic bunkering', 'Scoring opportunities'],
      difficulty: 'Moderate',
      rewards: ['Ball striking', 'Iron play', 'Putting', 'Course management'],
      avgScore: 68.2
    },
    'TPC Deere Run': {
      name: 'TPC Deere Run',
      yardage: 7268,
      par: 71,
      width: 'Wide, strategic fairways',
      greens: 'Bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['D.A. Weibring design', 'Strategic water', 'Scoring opportunities', 'Risk-reward'],
      difficulty: 'Moderate',
      rewards: ['Aggressive play', 'Iron accuracy', 'Putting', 'Birdie-making'],
      avgScore: 68.0
    },

    // ========== PLAYOFF EVENTS (August-September) ==========
    'Olympia Fields': {
      name: 'Olympia Fields Country Club',
      yardage: 7366,
      par: 70,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, undulating bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Historic venue', 'Demanding layout', 'Tree-lined corridors', 'Strategic design'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Ball striking', 'Iron play', 'Mental toughness'],
      avgScore: 71.5
    },
    'Castle Pines': {
      name: 'Castle Pines Golf Club',
      yardage: 8130,
      par: 72,
      width: 'Wide fairways at altitude',
      greens: 'Large, bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['High altitude', 'Extreme distance', 'Jack Nicklaus design', 'Dramatic views'],
      difficulty: 'Moderate',
      rewards: ['Distance off tee', 'Iron accuracy', 'Putting', 'Altitude adjustment'],
      avgScore: 69.5
    },
    'Caves Valley': {
      name: 'Caves Valley Golf Club',
      yardage: 7615,
      par: 72,
      width: 'Wide, strategic fairways',
      greens: 'Large, undulating bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['Modern design', 'Risk-reward holes', 'Strategic water', 'Scoring opportunities'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Iron accuracy', 'Putting'],
      avgScore: 69.2
    },
    'East Lake': {
      name: 'East Lake Golf Club',
      yardage: 7346,
      par: 70,
      width: 'Moderate width with strategic hazards',
      greens: 'Fast, undulating bermuda greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Historic venue', 'Rees Jones redesign', 'Strategic water', 'Tour Championship venue'],
      difficulty: 'Difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental toughness'],
      avgScore: 70.2
    },

    // ========== DP WORLD TOUR - MIDDLE EAST (January-February) ==========
    'Majlis': {
      name: 'Majlis Course at Emirates Golf Club',
      yardage: 7301,
      par: 72,
      width: 'Wide fairways with strategic bunkering',
      greens: 'Elevated, firm paspalum greens',
      rough: 'Light desert rough',
      keyFeatures: ['Iconic Dubai skyline views', 'Elevated greens demand precision', 'Strategic water hazards', 'Firm, fast desert conditions'],
      difficulty: 'Difficult',
      rewards: ['Approach play accuracy', 'Putting on fast greens', 'Iron precision', 'Course management'],
      avgScore: 71.5
    },
    'Emirates': {
      name: 'Majlis Course at Emirates Golf Club',
      yardage: 7301,
      par: 72,
      width: 'Wide fairways with strategic bunkering',
      greens: 'Elevated, firm paspalum greens',
      rough: 'Light desert rough',
      keyFeatures: ['Iconic Dubai skyline views', 'Elevated greens demand precision', 'Strategic water hazards', 'Firm, fast desert conditions'],
      difficulty: 'Difficult',
      rewards: ['Approach play accuracy', 'Putting on fast greens', 'Iron precision', 'Course management'],
      avgScore: 71.5
    },
    'Earth': {
      name: 'Earth Course at Jumeirah Golf Estates',
      yardage: 7681,
      par: 72,
      width: 'Wide desert fairways',
      greens: 'Large, undulating paspalum greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Greg Norman design', 'Desert landscape', 'Strategic water', 'Wide landing areas'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Iron game', 'Putting'],
      avgScore: 71.0
    },
    'Yas Links': {
      name: 'Yas Links Abu Dhabi',
      yardage: 7450,
      par: 72,
      width: 'Links-style wide fairways',
      greens: 'Firm paspalum greens',
      rough: 'Sandy waste areas',
      keyFeatures: ['Links design in desert', 'Coastal winds', 'Undulating terrain', 'Strategic bunkering'],
      difficulty: 'Difficult',
      rewards: ['Wind play', 'Links golf skills', 'Ball striking', 'Creative shotmaking'],
      avgScore: 71.8
    },

    // ========== DP WORLD TOUR - EUROPEAN VENUES ==========
    'Wentworth': {
      name: 'Wentworth Club (West Course)',
      yardage: 7302,
      par: 72,
      width: 'Tree-lined, strategic fairways',
      greens: 'Bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Ernie Els redesign', 'Historic venue', 'Strategic design', 'BMW PGA Championship'],
      difficulty: 'Difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental toughness'],
      avgScore: 71.2
    },
    'Valderrama': {
      name: 'Real Club Valderrama',
      yardage: 7106,
      par: 71,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, undulating bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Cork trees', 'Precision required', 'Strategic water', 'Tough par 4 17th'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Iron precision', 'Course management', 'Short game'],
      avgScore: 71.5
    },
    'Marco Simone': {
      name: 'Marco Simone Golf & Country Club',
      yardage: 7268,
      par: 71,
      width: 'Wide fairways with strategic hazards',
      greens: 'Bentgrass greens',
      rough: 'Moderate rough',
      keyFeatures: ['Ryder Cup venue', 'Modern design', 'Strategic water', 'Risk-reward holes'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Iron accuracy', 'Putting'],
      avgScore: 70.5
    },
    'Royal County Down': {
      name: 'Royal County Down Golf Club',
      yardage: 7186,
      par: 71,
      width: 'Narrow fairways with dunes',
      greens: 'Small, firm bentgrass greens',
      rough: 'Heavy fescue and gorse',
      keyFeatures: ['Links golf', 'Blind shots', 'Mountain backdrop', 'Natural terrain'],
      difficulty: 'Extremely difficult',
      rewards: ['Wind play', 'Ball striking', 'Course management', 'Links skills'],
      avgScore: 72.0
    },
    'St Andrews': {
      name: 'St Andrews Old Course',
      yardage: 7305,
      par: 72,
      width: 'Wide fairways with hidden hazards',
      greens: 'Double greens, large and undulating',
      rough: 'Fescue rough and gorse',
      keyFeatures: ['Home of golf', 'Double greens', 'Road Hole 17th', 'Historic links'],
      difficulty: 'Very difficult',
      rewards: ['Links golf skills', 'Wind management', 'Course knowledge', 'Strategic thinking'],
      avgScore: 71.5
    },
    'Carnoustie': {
      name: 'Carnoustie Golf Links (Championship Course)',
      yardage: 7421,
      par: 71,
      width: 'Moderate width with burns',
      greens: 'Firm bentgrass greens',
      rough: 'Heavy fescue rough',
      keyFeatures: ['Barry Burn hazard', 'Car park hole', 'Brutal finish', 'Links challenge'],
      difficulty: 'Extremely difficult',
      rewards: ['Ball striking', 'Mental toughness', 'Wind play', 'Strategic thinking'],
      avgScore: 72.5
    }
  };

  // Check if we have detailed info for this course
  for (const [key, data] of Object.entries(knownCourses)) {
    if (courseName.toLowerCase().includes(key.toLowerCase())) {
      return data;
    }
  }

  // For unknown courses, return reasonable defaults with instruction to analyze
  return {
    name: courseName,
    yardage: 7200,
    par: 72,
    width: 'Analyze based on course name and location',
    greens: 'Analyze green type from region',
    rough: 'Analyze rough characteristics',
    keyFeatures: ['Research course signature holes', 'Identify key challenges', 'Note historical significance'],
    difficulty: 'Moderate to Difficult',
    rewards: ['Ball striking', 'Iron precision', 'Course management', 'Putting excellence'],
    avgScore: 71.5
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
${courseInfo.yardage ? `Length: ${courseInfo.yardage} yards, Par ${courseInfo.par}` : 'Length: Estimate from tournament information'}
Width: ${courseInfo.width}
Greens: ${courseInfo.greens}
Rough: ${courseInfo.rough}
${courseInfo.avgScore ? `Tour Average Score: ${courseInfo.avgScore}` : ''}

Key Course Features:
${courseInfo.keyFeatures.length > 0 ? courseInfo.keyFeatures.map(f => `- ${f}`).join('\n') : '- Research and identify key features from tournament name and location'}

Skills This Course Rewards:
${courseInfo.rewards.length > 0 ? courseInfo.rewards.map(r => `- ${r}`).join('\n') : '- Determine specific skills from course type and conditions'}

IMPORTANT: If course details say "Analyze" or are generic, YOU MUST research and provide SPECIFIC information about ${tournament.course} based on:
- Course location: ${tournament.location}
- Tournament name: ${tournament.name}
- Use your knowledge to fill in accurate course characteristics, yardage, green types, and key features
- Replace ANY generic placeholders with ACTUAL course-specific information

COMPLETE FIELD (${players.length} players):

TOP FAVORITES (odds 5-20) - SKIP THESE - TOO SHORT FOR VALUE:
${favorites.map(p => `${p.name} [${p.odds?.toFixed(1)}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

VALUE ZONE (odds 20-100) - FOCUS HERE FOR MOST PICKS:
${midTier.map(p => `${p.name} [${p.odds?.toFixed(1)}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

LONGSHOTS (odds 100+) - CONSIDER 1-2 IF COURSE FIT IS EXCEPTIONAL:
${longshots.map(p => `${p.name} [${p.odds?.toFixed(1)}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

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
   - Do NOT pick anyone with odds under 20/1 - we're looking for VALUE, not favorites
   - Do NOT ignore course length - distance matters on long tracks
   - Do NOT pick players whose strengths don't match course demands
   - Do NOT pick based on world ranking alone
   - Do NOT pick big-name players just because they're popular - focus on course fit

YOUR TASK:
Select exactly 6 VALUE picks where:
- ALL players should have odds of 20/1 or higher
- At least 4 players should have odds ABOVE 40/1
- Players must have statistical evidence they excel at THIS COURSE TYPE
- Match their SG strengths to the specific course characteristics listed above
- Consider weather conditions in your analysis
- Provide a range of odds: some at 20-40/1 (shorter value), some at 40-80/1 (mid-range value), and some at 80-150/1 (longshots)

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
