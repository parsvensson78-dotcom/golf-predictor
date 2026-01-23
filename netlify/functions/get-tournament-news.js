const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * Tournament News & Preview Endpoint with Improved Error Handling
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body);
    const { tour } = body || {};
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[NEWS] Starting news fetch for ${tour || 'pga'} tour`);

    // Step 1: Get current tournament info
    let tournament;
    try {
      const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour || 'pga'}`, {
        timeout: 15000
      });
      tournament = tournamentResponse.data;
      console.log(`[NEWS] Tournament: ${tournament.name}`);
    } catch (tournError) {
      console.error('[NEWS] Failed to fetch tournament:', tournError.message);
      throw new Error('Could not fetch tournament information');
    }

    // Step 2: Fetch golf news from RSS feeds (with error handling)
    let newsArticles = [];
    try {
      newsArticles = await fetchGolfNews(tournament.name, tour);
      console.log(`[NEWS] Fetched ${newsArticles.length} news articles`);
    } catch (newsError) {
      console.error('[NEWS] Failed to fetch news:', newsError.message);
      // Continue without news - Claude can still generate preview
      newsArticles = [];
    }

    // Step 3: Get top players from tournament field
    const topPlayers = tournament.field ? tournament.field.slice(0, 20).map(p => p.name) : [];
    console.log(`[NEWS] Top ${topPlayers.length} players identified`);

    // Step 4: Call Claude API for preview analysis
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildPreviewPrompt(tournament, newsArticles, topPlayers);

    console.log(`[NEWS] Calling Claude API...`);
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
      console.error('[NEWS] Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // Calculate cost
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const inputCost = (inputTokens / 1000000) * 3.00;
    const outputCost = (outputTokens / 1000000) * 15.00;
    const totalCost = inputCost + outputCost;

    console.log(`[NEWS] Success! Returning preview with ${newsArticles.length} articles`);

    // Step 5: Return news and preview
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
        news: newsArticles,
        preview: {
          overview: preview.overview || '',
          storylines: preview.storylines || [],
          playersToWatch: preview.playersToWatch || [],
          bettingAngles: preview.bettingAngles || [],
          weatherImpact: preview.weatherImpact || ''
        },
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
    console.error('[NEWS] Fatal error:', error);
    console.error('[NEWS] Stack trace:', error.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to generate news preview',
        message: error.message,
        details: error.stack
      })
    };
  }
};

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
      console.log(`[NEWS] Fetching RSS feed: ${feed.url}`);
      
      const response = await axios.get(feed.url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GolfPredictor/1.0)',
          'Accept': 'application/rss+xml, application/xml, text/xml'
        },
        validateStatus: (status) => status === 200
      });

      console.log(`[NEWS] RSS feed fetched: ${feed.source}, length: ${response.data.length}`);

      // Parse XML
      const result = await parser.parseStringPromise(response.data);
      console.log(`[NEWS] RSS feed parsed: ${feed.source}`);
      
      // Extract items from RSS feed (handle different RSS formats)
      let items = [];
      if (result.rss && result.rss.channel) {
        // Standard RSS 2.0
        const channel = Array.isArray(result.rss.channel) ? result.rss.channel[0] : result.rss.channel;
        items = channel.item || [];
      } else if (result.feed && result.feed.entry) {
        // Atom feed
        items = result.feed.entry || [];
      }

      // Ensure items is an array
      if (!Array.isArray(items)) {
        items = [items];
      }

      console.log(`[NEWS] Found ${items.length} items in ${feed.source}`);

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

          // Clean up description (remove HTML tags)
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
            console.log(`[NEWS] Added article: ${article.title.substring(0, 50)}...`);
          }
        } catch (itemError) {
          console.error(`[NEWS] Error parsing item:`, itemError.message);
        }
      }

    } catch (feedError) {
      console.error(`[NEWS] Failed to fetch feed ${feed.url}:`, feedError.message);
      // Continue to next feed
    }
  }

  // Sort by date (newest first) and return top 8
  articles.sort((a, b) => {
    try {
      return new Date(b.pubDate) - new Date(a.pubDate);
    } catch {
      return 0;
    }
  });

  console.log(`[NEWS] Returning ${articles.length} total articles`);
  return articles.slice(0, 8);
}

/**
 * Extract text from XML element (handles various formats)
 */
function extractText(element) {
  if (!element) return '';
  
  if (typeof element === 'string') return element;
  
  if (element._) return element._;
  
  if (element['#text']) return element['#text'];
  
  if (typeof element === 'object') {
    // Try to find text in common properties
    if (element.content) return extractText(element.content);
    if (element.value) return extractText(element.value);
    if (element.text) return extractText(element.text);
  }
  
  return String(element);
}

/**
 * Build prompt for Claude's preview analysis
 */
function buildPreviewPrompt(tournament, newsArticles, topPlayers) {
  const newsText = newsArticles.map(a => 
    `Title: ${a.title}\nSource: ${a.source}\nSummary: ${a.description}\n`
  ).join('\n');

  return `You are a professional golf analyst creating a tournament preview and betting guide.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Dates: ${tournament.dates}

TOP PLAYERS IN FIELD:
${topPlayers.slice(0, 15).join(', ')}

RECENT NEWS ARTICLES:
${newsText || 'No recent news available - use your golf knowledge to provide insights'}

YOUR TASK:
Create a comprehensive tournament preview that synthesizes the news (if available) and provides betting insights.

Return ONLY valid JSON (no markdown):
{
  "overview": "2-3 sentence tournament overview. Include course difficulty, field strength, and what makes this tournament unique or interesting this year.",
  
  "storylines": [
    "Storyline 1: Major narrative or talking point (e.g., 'Defending champion returns after injury')",
    "Storyline 2: Another key storyline",
    "Storyline 3: Third important storyline",
    "Storyline 4: Fourth storyline if relevant"
  ],
  
  "playersToWatch": [
    {
      "name": "Player Name",
      "reason": "Why this player is worth watching this week - recent form, course history, or news-related angle. 1-2 sentences."
    },
    {
      "name": "Player Name",
      "reason": "Another player's story"
    },
    {
      "name": "Player Name",
      "reason": "Third player"
    }
  ],
  
  "bettingAngles": [
    "Betting angle 1: Specific insight for betting value (e.g., 'Course rewards accurate iron players - look for high SG:APP')",
    "Betting angle 2: Another betting consideration",
    "Betting angle 3: Third betting angle"
  ],
  
  "weatherImpact": "Brief note on how weather this week affects play and betting strategy. 1-2 sentences."
}

GUIDELINES:
- Base analysis on the news articles if provided
- Be specific with player names from the field
- Focus on actionable betting insights
- Keep each section concise but informative
- If news is limited, use your golf knowledge to fill in context`;
}
