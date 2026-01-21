const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches betting odds - improved version
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

    console.log(`Fetching odds for ${players.length} players in ${tournamentName}`);

    const oddsData = [];
    const oddsApiKey = process.env.ODDS_API_KEY;
    
    // Try The Odds API if available
    if (oddsApiKey) {
      try {
        const response = await axios.get('https://api.the-odds-api.com/v4/sports/golf_pga_championship/odds', {
          params: {
            apiKey: oddsApiKey,
            regions: 'us',
            markets: 'outrights',
            oddsFormat: 'decimal'
          },
          timeout: 10000
        });

        if (response.data && response.data.length > 0) {
          const events = response.data;
          
          players.forEach(playerName => {
            let foundOdds = null;
            
            for (const event of events) {
              if (event.bookmakers && event.bookmakers.length > 0) {
                const bookmaker = event.bookmakers[0];
                const market = bookmaker.markets?.find(m => m.key === 'outrights');
                
                if (market && market.outcomes) {
                  const outcome = market.outcomes.find(o => {
                    const lastName = playerName.split(' ').pop().toLowerCase();
                    return o.name.toLowerCase().includes(lastName);
                  });
                  
                  if (outcome) {
                    foundOdds = {
                      player: playerName,
                      odds: outcome.price,
                      bookmaker: bookmaker.title,
                      source: 'odds-api'
                    };
                    break;
                  }
                }
              }
            }
            
            if (foundOdds) {
              oddsData.push(foundOdds);
            }
          });
          
          console.log(`Found ${oddsData.length} odds from OddsAPI`);
        }
      } catch (apiError) {
        console.error('Odds API error:', apiError.message);
      }
    }

    // Generate realistic estimated odds based on world ranking and field position
    if (oddsData.length < players.length * 0.5) {
      console.log('Using improved estimated odds based on field position');
      
      players.forEach((player, index) => {
        // Check if we already have odds for this player
        const existingOdds = oddsData.find(o => o.player === player);
        if (existingOdds) return;
        
        // Generate more realistic odds based on position in field
        // Top players: 8-25 odds
        // Mid-tier: 25-80 odds
        // Longshots: 80-200+ odds
        
        let estimatedOdds;
        if (index < 10) {
          // Top 10: favorites
          estimatedOdds = 8 + (index * 1.5) + (Math.random() * 3);
        } else if (index < 30) {
          // Next 20: contenders
          estimatedOdds = 20 + ((index - 10) * 2) + (Math.random() * 8);
        } else if (index < 60) {
          // Mid-tier
          estimatedOdds = 60 + ((index - 30) * 1.5) + (Math.random() * 15);
        } else {
          // Longshots
          estimatedOdds = 100 + ((index - 60) * 2) + (Math.random() * 50);
        }
        
        oddsData.push({
          player,
          odds: Math.round(estimatedOdds * 10) / 10,
          bookmaker: 'Estimated',
          source: 'estimated',
          note: 'Estimated based on field position'
        });
      });
    }

    console.log(`Returning odds for ${oddsData.length} players`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=14400'
      },
      body: JSON.stringify({
        tournament: tournamentName,
        odds: oddsData,
        scrapedAt: new Date().toISOString(),
        usingEstimates: oddsData.some(o => o.source === 'estimated')
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
