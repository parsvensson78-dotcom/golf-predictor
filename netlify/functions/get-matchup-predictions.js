const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const {
  getBlobStore,
  normalizePlayerName,
  formatAmericanOdds,
  analyzeCourseSkillDemands,
  analyzeWeatherConditions,
  calculateClaudeCost,
  generateBlobKey
} = require('./shared-utils');

/**
 * Matchup Predictions Endpoint - OPTIMIZED VERSION v3
 * NOW WITH INTELLIGENT ANALYSIS:
 * - Course skill demands analysis
 * - Weather conditions analysis
 * - Recent form and course history data
 * - Better prompt with analytical framework
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

    // Step 5: Get weather forecast with detailed analysis
    let weatherData = null;
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const location = tournament.location.split(',')[0].trim();
        
        // Fetch detailed weather forecast
        const weatherResponse = await axios.get('https://api.weatherapi.com/v1/forecast.json', {
          params: {
            key: weatherApiKey,
            q: location,
            days: 4,
            aqi: 'no'
          },
          timeout: 8000
        });

        if (weatherResponse.data?.forecast) {
          const dayNames = ['Thursday', 'Friday', 'Saturday', 'Sunday'];
          const daily = weatherResponse.data.forecast.forecastday.map((day, index) => ({
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

          weatherData = { summary, daily };
          console.log(`[MATCHUP] Weather: Avg wind ${Math.round(daily.reduce((s, d) => s + d.windSpeed, 0) / daily.length)}mph`);
        }
      }
    } catch (weatherError) {
      console.error('[MATCHUP] Weather fetch failed:', weatherError.message);
    }

    const weatherSummary = weatherData?.summary || 'Weather data not available';

    // Step 6: Get course info
    let courseInfo;
    try {
      const courseResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour || 'pga'}&tournament=${encodeURIComponent(tournament.name)}`, {
        timeout: 10000
      });
      courseInfo = courseResponse.data;
      console.log(`[MATCHUP] Course: ${courseInfo.courseName}, ${courseInfo.yardage}y, Par ${courseInfo.par}`);
    } catch (courseError) {
      console.log('[MATCHUP] Course info fetch failed, using basic info');
      courseInfo = {
        courseName: tournament.course,
        eventName: tournament.name
      };
    }

    // Step 7: Analyze course demands and weather (using shared-utils)
    const courseDemands = analyzeCourseSkillDemands(courseInfo);
    const weatherAnalysis = analyzeWeatherConditions(weatherSummary);
    
    console.log('[MATCHUP] Course demands analyzed');
    console.log('[MATCHUP] Weather impact analyzed');

    // Step 8: Fetch recent form and course history
    const formData = await fetchRecentFormAndHistory(topPlayerNames, tournament.course, tour);
    console.log(`[MATCHUP] Form data for ${formData.players.length} players`);

    // Step 9: Prepare player data with stats, odds, and form
    const playersWithData = statsData.players
      .map(stat => {
        const oddsEntry = oddsData.odds.find(o => 
          normalizePlayerName(o.player) === normalizePlayerName(stat.player)
        );
        
        if (!oddsEntry) return null;

        const formEntry = formData.players.find(f => 
          f.normalizedName === normalizePlayerName(stat.player)
        );
        
        return {
          name: stat.player,
          rank: stat.stats.rank,
          odds: oddsEntry.odds,
          minOdds: oddsEntry.minOdds,
          maxOdds: oddsEntry.maxOdds,
          bookmakerCount: oddsEntry.bookmakerCount || 0,
          sgTotal: stat.stats.sgTotal,
          sgOTT: stat.stats.sgOTT,
          sgAPP: stat.stats.sgAPP,
          sgARG: stat.stats.sgARG,
          sgPutt: stat.stats.sgPutt,
          recentForm: formEntry?.recentResults || [],
          courseHistory: formEntry?.courseHistory || [],
          momentum: formEntry?.momentum || 'unknown'
        };
      })
      .filter(p => p !== null)
      .sort((a, b) => a.odds - b.odds);

    console.log(`[MATCHUP] ${playersWithData.length} players with complete data`);

    // Step 10: Build enhanced prompt for Claude
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildEnhancedMatchupPrompt(
      tournament,
      playersWithData,
      weatherSummary,
      weatherAnalysis,
      courseInfo,
      courseDemands,
      customMatchup
    );

    console.log(`[MATCHUP] Calling Claude API with enhanced analysis...`);
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

    // Calculate cost using shared utility
    const cost = calculateClaudeCost(message.usage);

    // Prepare response data
    const responseData = {
      tournament: {
        name: tournament.name,
        course: tournament.course,
        location: tournament.location,
        dates: tournament.dates,
        tour: tournament.tour
      },
      weather: weatherSummary,
      dailyForecast: weatherData?.daily || [],
      courseInfo: {
        name: courseInfo.courseName || courseInfo.eventName,
        courseName: courseInfo.courseName,
        par: courseInfo.par,
        yardage: courseInfo.yardage,
        width: courseInfo.width,
        greens: courseInfo.greens,
        rough: courseInfo.rough,
        difficulty: courseInfo.difficulty
      },
      courseAnalysis: {
        demands: courseDemands,
        weatherImpact: weatherAnalysis
      },
      suggestedMatchups: matchupData.suggestedMatchups || [],
      customMatchup: matchupData.customMatchup || null,
      generatedAt: new Date().toISOString(),
      tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      tokenBreakdown: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens
      },
      estimatedCost: cost
    };

    // Save to Netlify Blobs for caching
    try {
      const store = getBlobStore('matchups', context);
      const key = generateBlobKey(responseData.tournament.name, responseData.tournament.tour, responseData.generatedAt);

      await store.set(key, JSON.stringify(responseData));
      console.log(`[MATCHUP] Saved to blob: ${key}`);
    } catch (saveError) {
      console.error('[MATCHUP] Failed to save to Blobs:', saveError.message);
    }

    // Return matchup predictions
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify(responseData)
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
 * Fetch recent form and course history for players
 * (Copied from get-predictions.js)
 */
async function fetchRecentFormAndHistory(playerNames, courseName, tour) {
  const apiKey = process.env.DATAGOLF_API_KEY;
  
  if (!apiKey) {
    console.log('[MATCHUP-FORM] DataGolf API key not configured, skipping form data');
    return { players: [] };
  }
  
  const apiTour = tour === 'dp' ? 'euro' : (tour || 'pga');
  
  try {
    console.log(`[MATCHUP-FORM] Fetching recent tournament results...`);
    
    // Fetch schedule to get recent tournaments
    const scheduleUrl = `https://feeds.datagolf.com/get-schedule?tour=${apiTour}&file_format=json&key=${apiKey}`;
    const scheduleResponse = await axios.get(scheduleUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    const tournaments = Array.isArray(scheduleResponse.data.schedule) 
      ? scheduleResponse.data.schedule 
      : Object.values(scheduleResponse.data.schedule);

    const now = new Date();
    
    // Get completed tournaments
    const completedTournaments = tournaments
      .filter(t => {
        let tourneyEndDate;
        
        if (t.end_date) {
          tourneyEndDate = new Date(t.end_date);
        } else if (t.start_date) {
          tourneyEndDate = new Date(t.start_date);
          tourneyEndDate.setDate(tourneyEndDate.getDate() + 4);
        } else if (t.date) {
          tourneyEndDate = new Date(t.date);
          tourneyEndDate.setDate(tourneyEndDate.getDate() + 4);
        } else {
          return false;
        }
        
        const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
        return tourneyEndDate < oneDayAgo;
      })
      .sort((a, b) => {
        const aDate = new Date(a.end_date || a.start_date || a.date);
        const bDate = new Date(b.end_date || b.start_date || b.date);
        return bDate - aDate;
      })
      .slice(0, 10);

    // For each player, compile their recent results
    const playerFormData = {};
    
    for (const player of playerNames) {
      playerFormData[normalizePlayerName(player)] = {
        recentResults: [],
        courseHistory: [],
        momentum: 'unknown'
      };
    }

    // Fetch results for recent tournaments (only first 5 to save time)
    for (const tournament of completedTournaments.slice(0, 5)) {
      try {
        const fieldUrl = `https://feeds.datagolf.com/field-updates?tour=${apiTour}&file_format=json&key=${apiKey}`;
        const fieldResponse = await axios.get(fieldUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Golf-Predictor-App/1.0',
            'Accept': 'application/json'
          }
        });

        if (fieldResponse.data?.field) {
          const isCourseMatch = tournament.course?.toLowerCase().includes(courseName?.toLowerCase().split(' ')[0]) ||
                                courseName?.toLowerCase().includes(tournament.course?.toLowerCase().split(' ')[0]);

          for (const playerResult of fieldResponse.data.field) {
            if (!playerResult.player_name) continue;
            
            const normalizedName = normalizePlayerName(playerResult.player_name);
            if (playerFormData[normalizedName]) {
              const result = {
                tournament: tournament.event_name,
                date: tournament.date,
                position: playerResult.finish_position || playerResult.position,
                score: playerResult.total_to_par,
                madeCut: playerResult.made_cut !== false
              };

              playerFormData[normalizedName].recentResults.push(result);

              if (isCourseMatch) {
                playerFormData[normalizedName].courseHistory.push(result);
              }
            }
          }
        }
      } catch (error) {
        console.log(`[MATCHUP-FORM] Failed to fetch results for ${tournament.event_name}`);
      }
    }

    // Calculate momentum
    for (const normalizedName in playerFormData) {
      const recent = playerFormData[normalizedName].recentResults;
      if (recent.length >= 3) {
        const recentPositions = recent.slice(0, 3).map(r => parseInt(r.position) || 999);
        const olderPositions = recent.slice(3, 6).map(r => parseInt(r.position) || 999);
        
        if (recentPositions.length > 0 && olderPositions.length > 0) {
          const recentAvg = recentPositions.reduce((a, b) => a + b, 0) / recentPositions.length;
          const olderAvg = olderPositions.reduce((a, b) => a + b, 0) / olderPositions.length;
          
          if (recentAvg < olderAvg - 10) {
            playerFormData[normalizedName].momentum = '📈 Hot';
          } else if (recentAvg > olderAvg + 10) {
            playerFormData[normalizedName].momentum = '📉 Cold';
          } else {
            playerFormData[normalizedName].momentum = '➡️ Steady';
          }
        }
      }
    }

    return {
      players: Object.keys(playerFormData).map(normalizedName => ({
        normalizedName,
        ...playerFormData[normalizedName]
      }))
    };

  } catch (error) {
    console.error('[MATCHUP-FORM] Error fetching form data:', error.message);
    return { players: [] };
  }
}

/**
 * Build enhanced prompt with course analysis, weather analysis, and form data
 */
function buildEnhancedMatchupPrompt(tournament, players, weatherSummary, weatherAnalysis, courseInfo, courseDemands, customMatchup) {
  const topPlayers = players.slice(0, 50);
  const playerList = topPlayers.map(p => {
    const form = p.recentForm?.slice(0, 3).map(r => {
      const pos = r.position ? `T${r.position}` : 'MC';
      return pos;
    }).join(', ') || 'No data';
    
    const courseHist = p.courseHistory?.length > 0 
      ? p.courseHistory.map(r => `T${r.position}`).join(', ')
      : 'No history';

    return `${p.name} [${formatAmericanOdds(p.odds)}] - R${p.rank} | SG:${p.sgTotal?.toFixed(2) || 'N/A'} (OTT:${p.sgOTT?.toFixed(2) || 'N/A'} APP:${p.sgAPP?.toFixed(2) || 'N/A'} ARG:${p.sgARG?.toFixed(2) || 'N/A'} P:${p.sgPutt?.toFixed(2) || 'N/A'}) | Last3: ${form} | Course: ${courseHist} | ${p.momentum}`;
  }).join('\n');

  let customMatchupPrompt = '';
  if (customMatchup && customMatchup.playerA && customMatchup.playerB) {
    const playerA = players.find(p => p.name === customMatchup.playerA);
    const playerB = players.find(p => p.name === customMatchup.playerB);
    
    const formA = playerA?.recentForm?.slice(0, 3).map(r => r.position ? `T${r.position}` : 'MC').join(', ') || 'No data';
    const formB = playerB?.recentForm?.slice(0, 3).map(r => r.position ? `T${r.position}` : 'MC').join(', ') || 'No data';
    
    customMatchupPrompt = `
🎯 CUSTOM MATCHUP REQUESTED:
Player A: ${playerA?.name || customMatchup.playerA} [${playerA ? formatAmericanOdds(playerA.odds) : '?'}]
Stats: R${playerA?.rank || '?'} | SG:${playerA?.sgTotal?.toFixed(2) || '?'} (OTT:${playerA?.sgOTT?.toFixed(2) || '?'} APP:${playerA?.sgAPP?.toFixed(2) || '?'} ARG:${playerA?.sgARG?.toFixed(2) || '?'} P:${playerA?.sgPutt?.toFixed(2) || '?'})
Form: ${formA} | ${playerA?.momentum || '?'}

Player B: ${playerB?.name || customMatchup.playerB} [${playerB ? formatAmericanOdds(playerB.odds) : '?'}]
Stats: R${playerB?.rank || '?'} | SG:${playerB?.sgTotal?.toFixed(2) || '?'} (OTT:${playerB?.sgOTT?.toFixed(2) || '?'} APP:${playerB?.sgAPP?.toFixed(2) || '?'} ARG:${playerB?.sgARG?.toFixed(2) || '?'} P:${playerB?.sgPutt?.toFixed(2) || '?'})
Form: ${formB} | ${playerB?.momentum || '?'}

YOU MUST analyze this specific matchup and include it in your response as "customMatchup".
`;
  }

  return `Golf analyst: Generate 4-5 intelligent head-to-head matchup predictions.

TOURNAMENT: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName} | ${courseInfo.yardage || '?'}y Par ${courseInfo.par || '?'}

COURSE DEMANDS ANALYSIS:
${courseDemands}

WEATHER IMPACT ANALYSIS:
${weatherAnalysis}

TOP 50 PLAYERS (with form and course history):
${playerList}

${customMatchupPrompt}

ANALYSIS FRAMEWORK:
1. Course Fit (35%): Match SG stats to course demands above
2. Recent Form (25%): Last 3 tournaments + momentum trend
3. Course History (20%): Past performance at this venue
4. Weather Impact (15%): How conditions favor their game
5. Odds Value (5%): Ensuring interesting/competitive matchups

YOUR TASK:
1. Create 4-5 INTERESTING matchups between players with similar odds (within +500 of each other)
2. Mix tiers: favorites (+600 to +1500), mid-tier (+1500 to +4000), longshots (+4000+)
3. Pick winner and provide realistic win probability (52-65% range)
${customMatchup ? '4. Analyze the custom matchup requested above' : ''}

CRITICAL REQUIREMENTS:
- Compare SPECIFIC SG stats to the "Course Demands" section
- Reference recent form (use Last3 data provided)
- Note course history if available
- Explain weather impact based on "Weather Impact Analysis"
- Be realistic with win probabilities (52-65% for competitive matchups)

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
      "reasoning": "Course fit: [Compare specific SG stats to demands]. Form: [Recent results]. History: [Course performance]. Weather: [Impact on their game]. Probability reflects [edge explanation]."
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
    "reasoning": "Detailed 3-4 sentence analysis covering all 5 factors"
  }` : ''}
}`;
}
