const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches current PGA Tour tournament information from ESPN
 * Returns: tournament name, course name, location, field of players
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    
    // ESPN URLs
    const urls = {
      pga: 'https://www.espn.com/golf/schedule/_/tour/pga',
      dp: 'https://www.espn.com/golf/schedule/_/tour/eur'
    };

    const response = await axios.get(urls[tour], {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    // Find current/upcoming tournament
    let tournamentData = null;
    
    // Look for tournaments marked as "In Progress" or next upcoming
    $('.ScheduleTables').each((i, table) => {
      const status = $(table).find('.status').text().trim();
      
      if (status.includes('In Progress') || status.includes('Upcoming')) {
        const name = $(table).find('.Table__Title').text().trim();
        const location = $(table).find('.location').text().trim();
        const dates = $(table).find('.date').text().trim();
        
        // Try to get course name from tournament page link
        const link = $(table).find('a').attr('href');
        
        tournamentData = {
          name,
          location,
          dates,
          link: link ? `https://www.espn.com${link}` : null,
          tour: tour.toUpperCase()
        };
        
        return false; // Break loop
      }
    });

    if (!tournamentData || !tournamentData.link) {
      return {
        statusCode: 404,
        body: JSON.stringify({ 
          error: 'No current tournament found',
          tour 
        })
      };
    }

    // Fetch detailed tournament page for course info and field
    const tournamentResponse = await axios.get(tournamentData.link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });

    const $detail = cheerio.load(tournamentResponse.data);
    
    // Extract course name
    const courseName = $detail('.Course__Name').first().text().trim() || 
                       $detail('.Leaderboard__Course').first().text().trim() ||
                       'Course TBD';

    // Extract field of players with basic info
    const field = [];
    $detail('.Leaderboard__Player, .PlayerRow').slice(0, 156).each((i, row) => {
      const name = $(row).find('.Leaderboard__Player__Name, .PlayerRow__Name').text().trim();
      const rank = $(row).find('.rank').text().trim();
      
      if (name) {
        field.push({
          name: name.replace(/\s+/g, ' '),
          rank: rank || null
        });
      }
    });

    // If no field yet, try alternate selectors
    if (field.length === 0) {
      $detail('tr[data-player-id]').slice(0, 156).each((i, row) => {
        const name = $(row).find('.AnchorLink').first().text().trim();
        if (name) {
          field.push({
            name: name.replace(/\s+/g, ' '),
            rank: null
          });
        }
      });
    }

    const result = {
      ...tournamentData,
      course: courseName,
      fieldSize: field.length,
      field: field, // Return complete field - value can be anywhere!
      scrapedAt: new Date().toISOString()
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=43200' // 12 hours
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Tournament fetch error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to fetch tournament data',
        message: error.message 
      })
    };
  }
};
