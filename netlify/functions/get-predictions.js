const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { getStore } = require('@netlify/blobs');

/**
 * Main prediction endpoint - OPTIMIZED VERSION
 * Fetches data in parallel where possible and automatically saves predictions
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[START] Predictions for ${tour.toUpperCase()} tour`);

    // Step 1: Fetch tournament data
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;

    if (!tournament?.field?.length) {
      throw new Error('No tournament field data available');
    }

    console.log(`[TOURNAMENT] ${tournament.name} (${tournament.field.length} players)`);

    const playerNames = tournament.field.map(p => p.name);

    // Step 2-4: Fetch stats, odds, weather, and course info IN PARALLEL
    const [statsResponse, oddsResponse, weatherData, courseInfo] = await Promise.all([
      // Stats
      axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, 
        { players: playerNames }, 
        { timeout: 30000 }
      ),
      // Odds
      axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, 
        { tournamentName: tournament.name, players: playerNames, tour: tournament.tour }, 
        { timeout: 20000 }
      ),
      // Weather
      fetchWeather(tournament.location),
      // Course info
      axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour}&tournament=${encodeURIComponent(tournament.name)}`, 
        { timeout: 10000 }
      ).then(r => r.data)
    ]);

    const statsData = statsResponse.data;
    const oddsData = oddsResponse.data;

    console.log(`[DATA] Stats: ${statsData.players.length}, Odds: ${oddsData.odds.length}, Course: ${courseInfo.courseName || courseInfo.eventName}`);

    // Step 5: Merge player data (stats + odds)
    const playersWithData = mergePlayerData(statsData.players, oddsData.odds);

    console.log(`[MERGE] ${playersWithData.length} players with complete data`);

    // Step 6: Prepare data for Claude (top 80 players to avoid token limits)
    const topPlayers = playersWithData.slice(0, 80);
    console.log(`[CLAUDE] Analyzing top ${topPlayers.length} players`);

    // Step 7: Call Claude API
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildClaudePrompt(tournament, topPlayers, weatherData.summary, courseInfo);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    });

    // Step 8: Parse Claude response
    const predictions = parseClaudeResponse(message.content[0].text);
    console.log(`[CLAUDE] Generated ${predictions.picks?.length || 0} picks`);

    // Step 9: Enrich predictions with odds breakdown
    enrichPredictionsWithOdds(predictions, playersWithData);

    // Step 10: Calculate costs
    const cost = calculateCost(message.usage);

    const generatedAt = new Date().toISOString();

    // Step 11: Save predictions to Netlify Blobs for results tracking
    try {
      await savePredictionsToBlobs(tournament, predictions, courseInfo, weatherData, generatedAt);
      console.log('[SAVE] ✅ Predictions saved for results tracking');
    } catch (saveError) {
      console.error('[SAVE] Failed to save predictions:', saveError.message);
      // Don't fail the entire request if save fails
    }

    // Step 12: Return response
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
          tour: tournament.tour,
          eventId: tournament.eventId
        },
        weather: weatherData.summary,
        dailyForecast: weatherData.daily,
        courseInfo: {
          name: courseInfo.courseName || courseInfo.eventName,
          courseName: courseInfo.courseName,
          location: courseInfo.location,
          par: courseInfo.par,
          yardage: courseInfo.yardage,
          width: courseInfo.width,
          greens: courseInfo.greens,
          rough: courseInfo.rough,
          keyFeatures: courseInfo.keyFeatures || [],
          difficulty: courseInfo.difficulty,
          rewards: courseInfo.rewards || [],
          avgScore: courseInfo.avgScore,
          source: courseInfo.source
        },
        courseAnalysis: {
          type: predictions.courseType || 'Analysis not available',
          weatherImpact: predictions.weatherImpact || 'No significant impact expected',
          keyFactors: predictions.keyFactors || [],
          notes: predictions.courseNotes || ''
        },
        predictions: predictions.picks || predictions,
        generatedAt,
        tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
        tokenBreakdown: {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens
        },
        estimatedCost: cost
      })
    };

  } catch (error) {
    console.error('[ERROR]', error.message);
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
 * Save predictions to Netlify Blobs for results tracking
 */
async function savePredictionsToBlobs(tournament, predictions, courseInfo, weatherData, generatedAt) {
  const store = getStore('predictions');

  // Generate key from tournament name and date
  const tournamentSlug = tournament.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const date = new Date(generatedAt);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  
  const key = `${tournamentSlug}-${dateStr}`;

  // Prepare data to save
  const predictionData = {
    tournament: {
      name: tournament.name,
      course: tournament.course,
      location: tournament.location,
      dates: tournament.dates,
      tour: tournament.tour,
      eventId: tournament.eventId
    },
    courseInfo: {
      par: courseInfo?.par,
      yardage: courseInfo?.yardage,
      difficulty: courseInfo?.difficulty
    },
    weather: weatherData?.summary || 'Not available',
    predictions: (predictions.picks || predictions).map(pick => ({
      player: pick.player,
      odds: pick.odds,
      minOdds: pick.minOdds,
      maxOdds: pick.maxOdds,
      bestBookmaker: pick.bestBookmaker,
      reasoning: pick.reasoning
    })),
    metadata: {
      generatedAt,
      savedAt: new Date().toISOString(),
      pickCount: (predictions.picks || predictions).length,
      status: 'pending'
    }
  };

  await store.set(key, JSON.stringify(predictionData));
  console.log(`[SAVE] Saved to blob: ${key}`);
}

/**
 * Fetch weather data with error handling
 */
async function fetchWeather(location) {
  const weatherApiKey = process.env.WEATHER_API_KEY;
  
  if (!weatherApiKey || !location) {
    return { 
      summary: 'Weather data not available', 
      daily: [] 
    };
  }

  try {
    const city = location.split(',')[0].trim();
    const response = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
      params: { key: weatherApiKey, q: city, days: 4, aqi: 'no' },
      timeout: 8000
    });

    if (!response.data?.forecast) {
      return { summary: 'Weather data unavailable', daily: [] };
    }

    const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
    const daily = response.data.forecast.forecastday.map((day, index) => ({
      day: dayNames[index] || new Date(day.date).toLocaleDateString('en-US', { weekday: 'long' }),
      date: day.date,
      tempHigh: Math.round(day.day.maxtemp_f),
      tempLow: Math.round(day.day.mintemp_f),
      condition: day.day.condition.text,
      windSpeed: Math.round(day.day.maxwind_mph),
      chanceOfRain: day.day.daily_chance_of_rain,
      humidity: day.day.avghumidity
    }));

    const summary = daily.map(d => 
      `${d.day}: ${d.tempHigh}°F, ${d.condition}, Wind: ${d.windSpeed}mph, Rain: ${d.chanceOfRain}%`
    ).join(' | ');

    console.log(`[WEATHER] ${city} - Avg wind ${Math.round(daily.reduce((s, d) => s + d.windSpeed, 0) / daily.length)}mph`);

    return { summary, daily };

  } catch (error) {
    console.log('[WEATHER] Fetch failed:', error.message);
    return { 
      summary: error.response?.status === 401 ? 'Weather API key invalid' : 'Weather unavailable', 
      daily: [] 
    };
  }
}

/**
 * Merge stats and odds data for all players
 */
function mergePlayerData(statsPlayers, oddsPlayers) {
  return statsPlayers
    .map(statPlayer => {
      const oddsPlayer = oddsPlayers.find(op => 
        normalizePlayerName(op.player) === normalizePlayerName(statPlayer.name)
      );

      if (!oddsPlayer) return null;

      return {
        name: statPlayer.name,
        stats: {
          sgOTT: statPlayer.sgOTT || 0,
          sgAPP: statPlayer.sgAPP || 0,
          sgARG: statPlayer.sgARG || 0,
          sgPutt: statPlayer.sgPutt || 0,
          sgTotal: statPlayer.sgTotal || 0,
          drivingDist: statPlayer.drivingDistance,
          drivingAcc: statPlayer.drivingAccuracy,
          gir: statPlayer.gir
        },
        odds: oddsPlayer.odds,
        bookmakers: oddsPlayer.bookmakers || []
      };
    })
    .filter(p => p !== null)
    .sort((a, b) => a.odds - b.odds);
}

/**
 * Normalize player name for matching
 */
function normalizePlayerName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Enrich predictions with detailed odds breakdown
 */
function enrichPredictionsWithOdds(predictions, playersWithData) {
  const picks = predictions.picks || predictions;
  
  picks.forEach(pick => {
    const playerData = playersWithData.find(p => 
      normalizePlayerName(p.name) === normalizePlayerName(pick.player)
    );

    if (playerData?.bookmakers?.length > 0) {
      const bookmakerOdds = playerData.bookmakers.map(b => b.odds).filter(o => o > 0);
      
      if (bookmakerOdds.length > 0) {
        pick.minOdds = Math.min(...bookmakerOdds);
        pick.maxOdds = Math.max(...bookmakerOdds);
        
        const bestBookmaker = playerData.bookmakers.reduce((best, current) => 
          current.odds > best.odds ? current : best
        );
        pick.bestBookmaker = bestBookmaker.bookmaker;
      }
    }
  });
}

/**
 * Parse Claude's JSON response
 */
function parseClaudeResponse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('[PARSE] Failed to parse Claude response:', error.message);
    return { picks: [], error: 'Failed to parse predictions' };
  }
}

/**
 * Calculate API cost
 */
function calculateCost(usage) {
  const inputCost = (usage.input_tokens / 1000000) * 3.00;
  const outputCost = (usage.output_tokens / 1000000) * 15.00;
  return `$${(inputCost + outputCost).toFixed(4)}`;
}

/**
 * Format player list for prompt
 */
function formatPlayerList(players) {
  return players
    .map(p => `${p.name} (${Math.round(p.odds)}/1) | SG: OTT=${p.stats.sgOTT} APP=${p.stats.sgAPP} ARG=${p.stats.sgARG} Putt=${p.stats.sgPutt} Total=${p.stats.sgTotal}`)
    .join('\n');
}

/**
 * Build comprehensive Claude prompt
 */
function buildClaudePrompt(tournament, players, weatherSummary, courseInfo) {
  const favorites = players.filter(p => p.odds < 20);
  const midTier = players.filter(p => p.odds >= 20 && p.odds < 100);
  const longshots = players.filter(p => p.odds >= 100);

  const weatherAnalysis = analyzeWeatherConditions(weatherSummary);
  const courseSkillDemands = analyzeCourseSkillDemands(courseInfo);

  return `You are an expert golf analyst specializing in course-fit value betting. Your task is to identify 6 VALUE picks for ${tournament.name}.

TOURNAMENT: ${tournament.name}
COURSE: ${courseInfo.courseName || courseInfo.eventName} (${courseInfo.yardage || 'Unknown'} yards, Par ${courseInfo.par || 'Unknown'})
LOCATION: ${tournament.location}
DATES: ${tournament.dates}

COURSE CHARACTERISTICS:
${courseInfo.width ? `Width: ${courseInfo.width}` : ''}
${courseInfo.greens ? `Greens: ${courseInfo.greens}` : ''}
${courseInfo.rough ? `Rough: ${courseInfo.rough}` : ''}
${courseInfo.difficulty ? `Difficulty: ${courseInfo.difficulty}` : ''}
${courseInfo.keyFeatures?.length > 0 ? `Key Features: ${courseInfo.keyFeatures.join(', ')}` : ''}

PRIMARY SKILL DEMANDS (Course Analysis):
${courseSkillDemands}

WEATHER CONDITIONS & IMPACT:
${weatherAnalysis}

STROKES GAINED (SG) STATS EXPLAINED:
- SG:OTT (Off-The-Tee) = Driving distance + accuracy combined
- SG:APP (Approach) = Iron play, approach shots to green
- SG:ARG (Around-The-Green) = Short game, chipping, pitching
- SG:Putt (Putting) = Putting performance
- SG:Total = Overall performance (sum of all categories)
- Positive SG = Above PGA Tour average, Negative SG = Below average

PLAYER POOL (sorted by odds):

🔵 FAVORITES (odds <20) - AVOID THESE:
${formatPlayerList(favorites)}

💎 VALUE ZONE (odds 20-100) - PRIMARY FOCUS - MOST PICKS HERE:
${formatPlayerList(midTier)}

🎯 LONGSHOTS (odds 100+) - SELECT 1-2 ONLY IF EXCEPTIONAL COURSE FIT:
${formatPlayerList(longshots)}

YOUR TASK - MULTI-FACTOR ANALYSIS:
Select exactly 6 VALUE picks using this decision framework:

1. COURSE FIT (Most Important - 50% weight):
   - Match SG stats to PRIMARY SKILL DEMANDS listed above
   - Players MUST show strength in the course's key statistical categories
   - Example: Long course → prioritize high SG:OTT players
   - Example: Tight course → prioritize SG:APP and SG:ARG over SG:OTT

2. WEATHER ADAPTATION (Important - 25% weight):
   - Apply weather impact analysis from above
   - Wind → favor SG:OTT (ball flight control)
   - Wet conditions → favor length (SG:OTT) and wedge play (SG:APP)
   - Calm conditions → favor putting (SG:Putt becomes critical)

3. ODDS VALUE (Important - 25% weight):
   - ALL picks MUST be 20/1 or higher
   - At least 4 picks MUST be 40/1 or higher
   - Target distribution: 2 picks at 20-40/1, 2-3 picks at 40-80/1, 1-2 picks at 80-150/1
   - Avoid favorites under 20/1 regardless of course fit

4. STATISTICAL QUALITY:
   - Prefer positive SG:Total (indicates above-average player)
   - Look for "unbalanced" players (one great SG stat that matches course needs)
   - Example: Player with +1.2 SG:OTT but only +0.2 SG:Putt might be undervalued on long course

REASONING REQUIREMENTS:
For each pick, explain:
- Which PRIMARY SKILL DEMAND they satisfy (specific SG stat)
- How WEATHER impacts their performance
- Why their ODDS represent value (market inefficiency)
- Keep to 2-3 sentences max

Return ONLY valid JSON (no markdown):
{
  "courseType": "Comprehensive description of ${courseInfo.courseName || courseInfo.eventName}${courseInfo.yardage && courseInfo.par ? ` (${courseInfo.yardage} yards, Par ${courseInfo.par})` : ''}. Explain the course setup, primary challenge, what type of player succeeds here, and why this creates betting opportunities.",
  "weatherImpact": "Specific analysis of how the weather conditions will affect scoring and strategy. Which skills become more/less important? How does this create value opportunities?",
  "keyFactors": ["Factor 1: Course characteristic + required skill", "Factor 2: Weather impact + skill adaptation", "Factor 3: Scoring pattern + betting angle", "Factor 4: Historical pattern or course setup insight"],
  "courseNotes": "3-4 sentences analyzing: (1) The course's defining characteristic at ${courseInfo.yardage || 'this'} yards, (2) How weather amplifies or reduces certain demands, (3) What creates betting value - which player types are overpriced vs underpriced, (4) Specific stat ranges that correlate with success here.",
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "Course fit: [Specific SG stat match to PRIMARY DEMAND]. Weather: [How conditions favor this player]. Value: [Why odds are too high - market inefficiency]. 2-3 sentences."
    }
  ]
}`;
}

/**
 * Analyze weather conditions and provide specific player selection guidance
 */
function analyzeWeatherConditions(weatherSummary) {
  if (!weatherSummary || weatherSummary === 'Weather data not available') {
    return 'Weather data not available - focus purely on course characteristics and historical stats.';
  }

  // Parse weather summary to extract conditions
  const windSpeeds = [];
  const rainChances = [];
  let conditions = weatherSummary;

  // Extract wind speeds
  const windMatches = weatherSummary.match(/Wind:\s*(\d+)mph/g);
  if (windMatches) {
    windMatches.forEach(match => {
      const speed = parseInt(match.match(/\d+/)[0]);
      windSpeeds.push(speed);
    });
  }

  // Extract rain chances
  const rainMatches = weatherSummary.match(/Rain:\s*(\d+)%/g);
  if (rainMatches) {
    rainMatches.forEach(match => {
      const chance = parseInt(match.match(/\d+/)[0]);
      rainChances.push(chance);
    });
  }

  const avgWind = windSpeeds.length > 0 
    ? Math.round(windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length) 
    : 0;
  const maxWind = windSpeeds.length > 0 ? Math.max(...windSpeeds) : 0;
  const highRainDays = rainChances.filter(r => r > 50).length;
  const anyRainDays = rainChances.filter(r => r > 30).length;

  let analysis = [`Raw Conditions: ${conditions}`, ''];

  // Wind analysis
  if (maxWind >= 15) {
    analysis.push(`⚠️ HIGH WIND ALERT (${maxWind}mph max, ${avgWind}mph avg):`);
    analysis.push('- CRITICAL: Prioritize SG:OTT (ball flight control, trajectory management)');
    analysis.push('- Secondary: SG:APP (wind-adjusted approach shots)');
    analysis.push('- Deprioritize: SG:Putt (less important when scores are high)');
    analysis.push('- Look for: Players with positive SG:OTT who are undervalued');
  } else if (avgWind >= 10) {
    analysis.push(`💨 MODERATE WIND (${avgWind}mph avg):`);
    analysis.push('- Important: SG:OTT (trajectory control matters)');
    analysis.push('- Balanced approach: All SG categories relevant');
  } else {
    analysis.push(`😌 CALM CONDITIONS (${avgWind}mph avg):`);
    analysis.push('- CRITICAL: SG:Putt (low scores, putting wins)');
    analysis.push('- Secondary: SG:APP (hitting greens for birdie chances)');
    analysis.push('- Deprioritize: SG:OTT (length advantage reduced when conditions are easy)');
  }

  // Rain analysis
  if (highRainDays >= 2) {
    analysis.push('');
    analysis.push(`🌧️ WET CONDITIONS (${highRainDays} days with 50%+ rain):`);
    analysis.push('- CRITICAL: SG:OTT (length advantage on soft fairways/greens)');
    analysis.push('- Important: SG:APP (wedge play, soft greens hold shots)');
    analysis.push('- Consider: SG:ARG (soft conditions around greens)');
    analysis.push('- Deprioritize: SG:Putt (soft greens are easier to putt)');
  } else if (anyRainDays > 0) {
    analysis.push('');
    analysis.push(`🌦️ SOME RAIN POSSIBLE (${anyRainDays} days with 30%+ chance):`);
    analysis.push('- Slight advantage: Longer hitters (SG:OTT)');
    analysis.push('- Monitor: Conditions may soften as week progresses');
  }

  return analysis.join('\n');
}

/**
 * Analyze course characteristics to determine primary skill demands
 */
function analyzeCourseSkillDemands(courseInfo) {
  const demands = [];

  // Yardage analysis
  if (courseInfo.yardage) {
    if (courseInfo.yardage > 7500) {
      demands.push('1. SG:OTT (PRIMARY) - Extreme length demands elite driving distance and accuracy');
    } else if (courseInfo.yardage > 7300) {
      demands.push('1. SG:OTT (CRITICAL) - Long course heavily favors driving distance');
    } else if (courseInfo.yardage > 7100) {
      demands.push('1. SG:OTT (Important) - Above-average length requires solid driving');
    } else {
      demands.push('1. SG:APP + SG:ARG (PRIMARY) - Shorter course emphasizes precision over power');
    }
  }

  // Width analysis
  if (courseInfo.width) {
    const width = courseInfo.width.toLowerCase();
    if (width.includes('narrow') || width.includes('tight')) {
      demands.push('2. SG:APP (CRITICAL) - Narrow fairways require precision iron play and course management');
      demands.push('3. SG:ARG (Important) - Tight course means more scrambling opportunities');
    } else if (width.includes('wide') || width.includes('generous')) {
      demands.push('2. SG:OTT (Enhanced) - Wide fairways reward aggressive driving for distance');
      demands.push('3. SG:APP (Important) - Longer approaches from extra distance');
    }
  }

  // Rough analysis
  if (courseInfo.rough) {
    const rough = courseInfo.rough.toLowerCase();
    if (rough.includes('heavy') || rough.includes('thick') || rough.includes('penal')) {
      demands.push('4. SG:OTT (Accuracy) - Heavy rough severely punishes offline drives');
      demands.push('5. SG:ARG (Critical) - Recovery skills essential for scrambling');
    }
  }

  // Green analysis
  if (courseInfo.greens) {
    const greens = courseInfo.greens.toLowerCase();
    if (greens.includes('fast') || greens.includes('firm') || greens.includes('bentgrass')) {
      demands.push('6. SG:Putt (Enhanced) - Fast greens amplify putting skill differences');
    } else if (greens.includes('poa') || greens.includes('bumpy')) {
      demands.push('6. SG:APP (Critical) - Inconsistent greens demand precise approach distance control');
    }
  }

  // Difficulty analysis
  if (courseInfo.difficulty) {
    const difficulty = courseInfo.difficulty.toLowerCase();
    if (difficulty.includes('very difficult') || difficulty.includes('extremely')) {
      demands.push('7. SG:Total (Quality) - Difficult course requires well-rounded elite players');
    }
  }

  // Default if no specific demands identified
  if (demands.length === 0) {
    demands.push('1. SG:OTT (Important) - Driving quality sets up scoring opportunities');
    demands.push('2. SG:APP (Important) - Iron play for green-in-regulation');
    demands.push('3. SG:ARG (Moderate) - Short game for scrambling');
    demands.push('4. SG:Putt (Moderate) - Putting to convert scoring chances');
  }

  return demands.join('\n');
}
