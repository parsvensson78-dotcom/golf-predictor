const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const xml2js = require('xml2js');

/**
 * Tournament News & Preview Endpoint
 * Fetches latest golf news and generates AI preview
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`Fetching news and preview for ${tour.toUpperCase()} tour`);

    // Step 1: Get current tournament info
    const tournamentResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=${tour}`, {
      timeout: 15000
    });
    const tournament = tournamentResponse.data;

    if (!tournament) {
      throw new Error('No tournament data available');
    }

    console.log(`Tournament: ${tournament.name}`);

    // Step 2: Fetch golf news from multiple RSS feeds
    const newsArticles = await fetchGolfNews(tournament.name, tour);
    console.log(`Fetched ${newsArticles.length} news articles`);

    // Step 3: Get top players from tournament field
    const topPlayers = tournament.field ? tournament.field.slice(0, 20).map(p => p.name) : [];

    // Step 4: Call Claude API for preview analysis
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const prompt = buildPreviewPrompt(tournament, newsArticles, topPlayers);

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
    
    // Parse JSON response from Claude
    let preview;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      preview = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);
    } catch (parseError) {
      console.error('Failed to parse Claude response:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // Calculate cost
    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;
    const inputCost = (inputTokens / 1000000) * 3.00;
    const outputCost = (outputTokens / 1000000) * 15.00;
    const totalCost = inputCost + outputCost;

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
    console.error('News preview error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to generate news preview',
        message: error.message 
      })
    };
  }
};

/**
 * Fetch golf news from RSS feeds
 */
async function fetchGolfNews(tournamentName, tour) {
  const articles = [];
  const parser = new xml2js.Parser();

  // RSS Feed URLs
  const feeds = [
    'https://www.pgatour.com/feeds/news.rss',
    'https://www.espn.com/espn/rss/golf/news'
  ];

  for (const feedUrl of feeds) {
    try {
      console.log(`Fetching RSS feed: ${feedUrl}`);
      
      const response = await axios.get(feedUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GolfPredictor/1.0)'
        }
      });

      const result = await parser.parseStringPromise(response.data);
      
      // Parse RSS items
      const items = result.rss?.channel?.[0]?.item || result.feed?.entry || [];
      
      // Extract articles (take first 5 from each feed)
      for (const item of items.slice(0, 5)) {
        const article = {
          title: item.title?.[0] || item.title || '',
          description: item.description?.[0] || item.summary?.[0] || '',
          link: item.link?.[0]?._ || item.link?.[0] || item.link || '',
          pubDate: item.pubDate?.[0] || item.published?.[0] || '',
          source: feedUrl.includes('pgatour') ? 'PGA Tour' : 'ESPN Golf'
        };

        // Clean up description (remove HTML tags)
        if (article.description) {
          article.description = article.description
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .trim()
            .substring(0, 300);
        }

        if (article.title) {
          articles.push(article);
        }
      }

    } catch (feedError) {
      console.error(`Failed to fetch feed ${feedUrl}:`, feedError.message);
    }
  }

  // Sort by date (newest first) and return top 8
  articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return articles.slice(0, 8);
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
${newsText || 'No recent news available'}

YOUR TASK:
Create a comprehensive tournament preview that synthesizes the news and provides betting insights.

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
- Base analysis on the news articles provided
- Be specific with player names and details from news
- Focus on actionable betting insights
- Keep each section concise but informative
- If news is limited, use your golf knowledge to fill in context`;
}
