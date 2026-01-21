const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches betting odds for tournament players
 * Can use OddsAPI or scrape from betting sites
 */
exports.handler = async (event, context) => {
  try {
    const { tournamentName, players } = JSON.parse(event.body || '{}');
    
    if (!players || !Array.isArray(players)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Players array required' })
      };
    }

    const oddsData = [];

    // Option 1: Use The Odds API if key is available
    const oddsApiKey = process.env.ODDS_API_KEY;
    
    if (oddsApiKey) {
      try {
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/golf_pga_championship/odds', {
          params: {
            apiKey: oddsApiKey,
            regions: 'us',
            markets: 'h2h',
            oddsFormat: 'decimal'
          },
          timeout: 10000
        });

        // Parse odds from API response
        if (response.data && response.data.length > 0) {
          const event = response.data[0];
          
          players.forEach(playerName => {
            const outcome = event.bookmakers?.[0]?.markets?.[0]?.outcomes?.find(
              o => o.name.toLowerCase().includes(playerName.toLowerCase().split(' ').pop())
            );
            
            if (outcome) {
              oddsData.push({
                player: playerName,
                odds: outcome.price,
                bookmaker: event.bookmakers[0].title,
                source: 'odds-api'
              });
            }
          });
        }
      } catch (apiError) {
        console.error('Odds API error:', apiError.message);
      }
    }

    // Option 2: Scrape from OddsChecker or similar
    if (oddsData.length === 0) {
      try {
        // This is a fallback - scraping odds from a public site
        const response = await axios.get('https://www.oddsportal.com/golf/', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        });

        const $ = cheerio.load(response.data);
        
        // Parse odds table (structure varies by site)
        $('.odds-row, .participant-row').each((i, row) => {
          const name = $(row).find('.participant-name').text().trim();
          const odds = $(row).find('.odds-value').first().text().trim();
          
          if (name && odds) {
            const matchedPlayer = players.find(p => 
              name.toLowerCase().includes(p.toLowerCase().split(' ').pop())
            );
            
            if (matchedPlayer) {
              oddsData.push({
                player: matchedPlayer,
                odds: parseFloat(odds) || odds,
                bookmaker: 'OddsPortal',
                source: 'scrape'
              });
            }
          }
        });
      } catch (scrapeError) {
        console.error('Odds scraping error:', scrapeError.message);
      }
    }

    // Option 3: Return mock data if no real odds available
    // (for development/testing)
    if (oddsData.length === 0) {
      console.log('Using fallback odds generation');
      
      players.forEach((player, index) => {
        // Generate realistic odds based on position (lower = better odds)
        const baseOdds = 15 + (index * 5);
        const randomVariation = Math.random() * 10 - 5;
        
        oddsData.push({
          player,
          odds: Math.max(5, baseOdds + randomVariation),
          bookmaker: 'Estimated',
          source: 'fallback',
          note: 'Odds not available - using estimates'
        });
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=14400' // 4 hours
      },
      body: JSON.stringify({
        tournament: tournamentName,
        odds: oddsData,
        scrapedAt: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('Odds fetch error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to fetch odds',
        message: error.message 
      })
    };
  }
};
