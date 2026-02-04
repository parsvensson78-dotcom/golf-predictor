const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const xml2js = require('xml2js');
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
 * Tournament News & Preview Endpoint - UPGRADED VERSION v2
 * NOW WITH INTELLIGENT ANALYSIS:
 * - Course skill demands analysis
 * - Weather conditions analysis with actual forecast data
 * - Top players stats and recent form
 * - RSS news feeds
 * - Comprehensive preview generation
 * - Blob storage for caching
 */
exports.handler = async (event, context) => {
  console.log('[NEWS] Function invoked');
  console.log('[NEWS] Method:', event.httpMethod);

  try {
    // Determine tour from multiple possible sources
    let tour = 'pga'; // Default
    
    // Try query parameters first (most reliable for GET requests)
    if (event.queryStringParameters && event.queryStringParameters.tour) {
      tour = event.queryStringParameters.tour;
      console.log('[NEWS] Tour from query params:', tour);
    }
    // Try body if it exists (for POST requests)
    else if (event.body && event.body.trim() !== '') {
      try {
        const body = JSON.parse(event.body);
        if (body.tour) {
          tour = body.tour;
          console.log('[NEWS] Tour from body:', tour);
        }
      } catch (parseError) {
        console.log('[NEWS] Body parse failed, using default tour');
      }
    }
    
    const baseUrl = process.env.URL || 'http://localhost:8888';
    console.log(`[NEWS] Starting comprehensive preview for ${tour} tour`);

    // Step 1: Get current tournament info
    let tournament;
    try {
      console.log('[NEWS] Fetching tournament info...');
      const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
        timeout: 15000
      });
      tournament = tournamentResponse.data;
      console.log(`[NEWS] Tournament: ${tournament.name}`);
    } catch (tournError) {
      console.error('[NEWS] Failed to fetch tournament:', tournError.message);
      throw new Error('Could not fetch tournament information');
    }

    // Step 2: Fetch golf news from RSS feeds (in parallel with other data)
    const newsPromise = fetchGolfNews(tournament.name, tour);

    // Step 3: Get course info
    let courseInfo;
    try {
      const courseResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-course-info?tour=${tour}&tournament=${encodeURIComponent(tournament.name)}`, {
        timeout: 10000
      });
      courseInfo = courseResponse.data;
      console.log(`[NEWS] Course: ${courseInfo.courseName}, ${courseInfo.yardage}y, Par ${courseInfo.par}`);
    } catch (courseError) {
      console.log('[NEWS] Course info fetch failed, using basic info');
      courseInfo = {
        courseName: tournament.course,
        eventName: tournament.name
      };
    }

    // Step 4: Get weather forecast with detailed analysis
    let weatherData = null;
    try {
      const weatherApiKey = process.env.WEATHER_API_KEY;
      if (weatherApiKey && tournament.location) {
        const location = tournament.location.split(',')[0].trim();
        
        console.log('[NEWS] Fetching weather forecast...');
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
          console.log(`[NEWS] Weather: Avg wind ${Math.round(daily.reduce((s, d) => s + d.windSpeed, 0) / daily.length)}mph`);
        }
      }
    } catch (weatherError) {
      console.error('[NEWS] Weather fetch failed:', weatherError.message);
    }

    const weatherSummary = weatherData?.summary || 'Weather data not available';

    // Step 5: Analyze course demands and weather (using shared-utils)
    const courseDemands = analyzeCourseSkillDemands(courseInfo);
    const weatherAnalysis = analyzeWeatherConditions(weatherSummary);
    
    console.log('[NEWS] Course demands analyzed');
    console.log('[NEWS] Weather impact analyzed');

    // Step 6: Get top players from tournament field with stats and odds
    const playerNames = tournament.field ? tournament.field.slice(0, 30).map(p => p.name) : [];
    console.log(`[NEWS] Analyzing top ${playerNames.length} players`);

    let playersWithData = [];
    if (playerNames.length > 0) {
      try {
        // Fetch stats and odds in parallel
        const [statsResponse, oddsResponse] = await Promise.all([
          axios.post(`${baseUrl}/.netlify/functions/fetch-stats`, 
            { players: playerNames }, 
            { timeout: 25000 }
          ),
          axios.post(`${baseUrl}/.netlify/functions/fetch-odds`, 
            { tournamentName: tournament.name, players: playerNames, tour: tournament.tour }, 
            { timeout: 20000 }
          )
        ]);

        const statsData = statsResponse.data;
        const oddsData = oddsResponse.data;

        // Get recent form data
        const formData = await fetchRecentFormAndHistory(playerNames, tournament.course, tour);

        // Merge player data
        playersWithData = statsData.players
          .map(stat => {
            const oddsEntry = oddsData.odds.find(o => 
              normalizePlayerName(o.player) === normalizePlayerName(stat.player)
            );
            
            const formEntry = formData.players.find(f => 
              f.normalizedName === normalizePlayerName(stat.player)
            );

            if (!oddsEntry) return null;
            
            return {
              name: stat.player,
              rank: stat.stats.rank,
              odds: oddsEntry.odds,
              sgTotal: stat.stats.sgTotal,
              sgOTT: stat.stats.sgOTT,
              sgAPP: stat.stats.sgAPP,
              sgARG: stat.stats.sgARG,
              sgPutt: stat.stats.sgPutt,
              recentForm: formEntry?.recentResults?.slice(0, 3) || [],
              courseHistory: formEntry?.courseHistory || [],
              momentum: formEntry?.momentum || 'unknown'
            };
          })
          .filter(p => p !== null)
          .sort((a, b) => a.odds - b.odds)
          .slice(0, 20); // Top 20 for preview

        console.log(`[NEWS] ${playersWithData.length} players with complete data`);
      } catch (playerDataError) {
        console.error('[NEWS] Failed to fetch player data:', playerDataError.message);
        // Continue with just player names
      }
    }

    // Step 7: Wait for news articles
    const newsArticles = await newsPromise;
    console.log(`[NEWS] ${newsArticles.length} news articles fetched`);

    // Step 8: Call Claude API for comprehensive preview
    console.log('[NEWS] Calling Claude API for comprehensive preview...');
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildEnhancedPreviewPrompt(
      tournament,
      newsArticles,
      playersWithData,
      courseInfo,
      courseDemands,
      weatherSummary,
      weatherAnalysis
    );

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      temperature: 0.5,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    console.log(`[NEWS] Claude response received`);
    
    // Parse JSON response from Claude
    let preview;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      preview = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
      console.log(`[NEWS] Preview parsed successfully`);
    } catch (parseError) {
      console.error('[NEWS] Failed to parse Claude response:', responseText.substring(0, 200));
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
      news: newsArticles,
      preview: {
        overview: preview.overview || '',
        storylines: preview.storylines || [],
        playersToWatch: preview.playersToWatch || [],
        bettingAngles: preview.bettingAngles || [],
        weatherImpact: preview.weatherImpact || ''
      },
      generatedAt: new Date().toISOString(),
      tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
      tokenBreakdown: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens
      },
      estimatedCost: cost
    };

    // Step 9: Save to Netlify Blobs for caching
    try {
      const store = getBlobStore('news', context);
      const key = generateBlobKey(responseData.tournament.name, responseData.tournament.tour, responseData.generatedAt);

      await store.set(key, JSON.stringify(responseData));
      console.log(`[NEWS] Saved to blob: ${key}`);
    } catch (saveError) {
      console.error('[NEWS] Failed to save to Blobs:', saveError.message);
    }

    console.log(`[NEWS] Success! Returning comprehensive preview`);

    // Return news and preview
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      },
      body: JSON.stringify(responseData)
    };

  } catch (error) {
    console.error('[NEWS] Fatal error:', error.message);
    console.error('[NEWS] Stack trace:', error.stack);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        error: 'Failed to generate news preview',
        message: error.message
      })
    };
  }
};

/**
 * Fetch recent form and course history for players
 */
async function fetchRecentFormAndHistory(playerNames, courseName, tour) {
  const apiKey = process.env.DATAGOLF_API_KEY;
  
  if (!apiKey) {
    console.log('[NEWS-FORM] DataGolf API key not configured, skipping form data');
    return { players: [] };
  }
  
  const apiTour = tour === 'dp' ? 'euro' : (tour || 'pga');
  
  try {
    // Fetch schedule
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
      .slice(0, 8);

    const playerFormData = {};
    
    for (const player of playerNames) {
      playerFormData[normalizePlayerName(player)] = {
        recentResults: [],
        courseHistory: [],
        momentum: 'unknown'
      };
    }

    // Fetch results for recent tournaments (first 5 to save time)
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
                position: playerResult.finish_position || playerResult.position,
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
        // Continue on error
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
    console.error('[NEWS-FORM] Error fetching form data:', error.message);
    return { players: [] };
  }
}

/**
 * Fetch golf news from RSS feeds with robust error handling
 */
async function fetchGolfNews(tournamentName, tour) {
  const articles = [];
  const parser = new xml2js.Parser({
    explicitArray: false,
    ignoreAttrs: false,
    trim: true
  });

  // RSS Feed URLs
  const feeds = [
    {
      url: 'https://golf.com/feed/',
      source: 'Golf.com'
    },
    {
      url: 'https://www.espn.com/espn/rss/golf/news',
      source: 'ESPN Golf'
    }
  ];

  for (const feed of feeds) {
    try {
      const response = await axios.get(feed.url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GolfPredictor/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml'
        },
        validateStatus: (status) => status === 200
      });

      const result = await parser.parseStringPromise(response.data);
      
      // Extract items from RSS feed
      let items = [];
      if (result.rss && result.rss.channel) {
        const channel = Array.isArray(result.rss.channel) ? result.rss.channel[0] : result.rss.channel;
        items = channel.item || [];
      } else if (result.feed && result.feed.entry) {
        items = result.feed.entry || [];
      }

      if (!Array.isArray(items)) {
        items = [items];
      }

      // Extract articles (take first 5 from each feed)
      for (const item of items.slice(0, 5)) {
        try {
          const article = {
            title: extractText(item.title) || '',
            description: extractText(item.description || item.summary || item.content) || '',
            link: extractText(item.link) || '',
            pubDate: extractText(item.pubDate || item.published || item.updated) || new Date().toISOString(),
            source: feed.source
          };

          // Clean up description
          if (article.description) {
            article.description = article.description
              .replace(/<[^>]*>/g, '')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .trim()
              .substring(0, 300);
          }

          if (article.title && article.title.length > 5) {
            articles.push(article);
          }
        } catch (itemError) {
          // Continue on error
        }
      }

    } catch (feedError) {
      console.error(`[NEWS] Failed to fetch feed ${feed.url}:`, feedError.message);
    }
  }

  // Sort by date and return top 8
  articles.sort((a, b) => {
    try {
      return new Date(b.pubDate) - new Date(a.pubDate);
    } catch {
      return 0;
    }
  });

  return articles.slice(0, 8);
}

/**
 * Extract text from XML element
 */
function extractText(element) {
  if (!element) return '';
  if (typeof element === 'string') return element;
  if (element._) return element._;
  if (element['#text']) return element['#text'];
  
  if (typeof element === 'object') {
    if (element.content) return extractText(element.content);
    if (element.value) return extractText(element.value);
    if (element.text) return extractText(element.text);
  }
  
  return String(element);
}

/**
 * Build enhanced prompt with all tournament data
 */
function buildEnhancedPreviewPrompt(tournament, newsArticles, players, courseInfo, courseDemands, weatherSummary, weatherAnalysis) {
  const newsText = newsArticles.map(a => 
    `Title: ${a.title}\nSource: ${a.source}\nSummary: ${a.description}\n`
  ).join('\n');

  const playersText = players.slice(0, 15).map(p => {
    const form = p.recentForm?.map(r => r.position ? `T${r.position}` : 'MC').join(', ') || 'No data';
    const courseHist = p.courseHistory?.length > 0 
      ? p.courseHistory.map(r => `T${r.position}`).join(', ')
      : 'No history';

    return `${p.name} [${formatAmericanOdds(p.odds)}] - R${p.rank} | SG:${p.sgTotal?.toFixed(2) || '?'} (OTT:${p.sgOTT?.toFixed(2) || '?'} APP:${p.sgAPP?.toFixed(2) || '?'} ARG:${p.sgARG?.toFixed(2) || '?'} P:${p.sgPutt?.toFixed(2) || '?'}) | Last3: ${form} | Course: ${courseHist} | ${p.momentum}`;
  }).join('\n');

  return `You are a professional golf analyst creating a comprehensive tournament preview and betting guide.

TOURNAMENT:
Name: ${tournament.name}
Course: ${courseInfo.courseName || courseInfo.eventName} | ${courseInfo.yardage || '?'}y Par ${courseInfo.par || '?'}
Location: ${tournament.location}
Dates: ${tournament.dates}

COURSE DEMANDS ANALYSIS:
${courseDemands}

WEATHER ANALYSIS:
${weatherAnalysis}

TOP PLAYERS IN FIELD (with stats and form):
${playersText || 'Player data not available'}

RECENT NEWS ARTICLES:
${newsText || 'No recent news available'}

YOUR TASK:
Create a comprehensive tournament preview that synthesizes ALL available data - course characteristics, weather impact, player stats, recent form, and news.

Return ONLY valid JSON (no markdown):
{
  "overview": "2-3 sentences. Synthesize course difficulty (from course demands), field strength (top players), weather impact, and what makes this tournament interesting. Be specific with course characteristics and weather conditions.",
  
  "storylines": [
    "Storyline 1: Based on player form, course history, or news. Be specific with names and stats.",
    "Storyline 2: Another key storyline from the data",
    "Storyline 3: Weather or course-related storyline",
    "Storyline 4: Field strength or betting angle storyline"
  ],
  
  "playersToWatch": [
    {
      "name": "Player Name (from player list)",
      "reason": "Why this player is worth watching - reference their SG stats, course fit from demands analysis, recent form (Last3), momentum, or course history. 2-3 sentences with specific data."
    },
    {
      "name": "Player Name",
      "reason": "Another player with data-driven reasoning"
    },
    {
      "name": "Player Name",
      "reason": "Third player analysis"
    },
    {
      "name": "Player Name",
      "reason": "Fourth player if relevant"
    }
  ],
  
  "bettingAngles": [
    "Angle 1: Specific insight from course demands (e.g., 'SG:OTT CRITICAL - target players with +0.5 or better OTT')",
    "Angle 2: Weather-based angle from weather analysis",
    "Angle 3: Form-based angle from momentum trends",
    "Angle 4: Value angle from odds vs stats mismatch"
  ],
  
  "weatherImpact": "2-3 sentences on how the weather analysis affects play and betting strategy this week. Reference specific conditions from the weather analysis."
}

CRITICAL REQUIREMENTS:
- Use SPECIFIC player names from the player list
- Reference ACTUAL SG stats when discussing players
- Cite COURSE DEMANDS when explaining what matters
- Use WEATHER ANALYSIS for conditions impact
- Include RECENT FORM (Last3) and MOMENTUM when available
- Base analysis on DATA, not generic golf knowledge
- Be actionable for betting decisions`;
}
