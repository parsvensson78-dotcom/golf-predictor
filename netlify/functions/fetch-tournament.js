const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches current PGA/DP World Tour tournament from ESPN
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    
    console.log(`Fetching ${tour.toUpperCase()} tournament data...`);
    
    // ESPN tournament URLs - fetch the leaderboard directly
    const urls = {
      pga: 'https://www.espn.com/golf/leaderboard',
      dp: 'https://www.espn.com/golf/leaderboard/_/tour/eur'
    };

    const response = await axios.get(urls[tour], {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    
    // Extract tournament name
    const tournamentName = $('.Leaderboard__Event__Title').first().text().trim() ||
                          $('.headline').first().text().trim() ||
                          $('h1').first().text().trim();
    
    if (!tournamentName) {
      console.log('No tournament name found - likely no active tournament');
      return {
        statusCode: 404,
        body: JSON.stringify({ 
          error: 'No current tournament found',
          tour: tour.toUpperCase(),
          debug: 'Could not find tournament name on leaderboard page'
        })
      };
    }

    console.log(`Found tournament: ${tournamentName}`);

    // Extract course and location
    const courseInfo = $('.Leaderboard__Course__Location').text().trim() ||
                      $('.Table__Title').text().trim();
    
    const courseName = $('.Leaderboard__Course__Name').text().trim() || 
                      courseInfo.split(',')[0] || 
                      'Course TBD';
    
    const location = courseInfo || 'Location TBD';

    // Extract dates
    const dates = $('.Leaderboard__Event__Date').text().trim() || 
                 $('.Leaderboard__Event__Dates').text().trim() ||
                 'Dates TBD';

    // Extract field of players
    const field = [];
    
    // Try multiple selectors for player rows
    const playerRows = $('tbody tr, .Leaderboard__Player, .PlayerRow, tr.Table__TR');
    
    console.log(`Found ${playerRows.length} potential player rows`);
    
    playerRows.each((i, row) => {
      if (field.length >= 156) return false; // Max field size
      
      const $row = $(row);
      
      // Try various selectors for player name
      let name = $row.find('.Leaderboard__Player__Name').text().trim() ||
                $row.find('.PlayerRow__Name').text().trim() ||
                $row.find('td a').first().text().trim() ||
                $row.find('.AnchorLink').first().text().trim();
      
      // Clean up name
      name = name.replace(/\s+/g, ' ').trim();
      
      if (name && name.length > 2 && !name.includes('PLAYER') && !name.includes('POS')) {
        const rank = $row.find('.rank, .Table__TD:first-child').text().trim();
        
        field.push({
          name: name,
          rank: rank || null
        });
      }
    });

    console.log(`Extracted ${field.length} players from field`);

    if (field.length === 0) {
      console.log('Warning: No players found in field');
      // Return success anyway with empty field - better than failing
    }

    const result = {
      name: tournamentName,
      course: courseName,
      location: location,
      dates: dates,
      tour: tour.toUpperCase(),
      fieldSize: field.length,
      field: field,
      scrapedAt: new Date().toISOString()
    };

    console.log(`Successfully scraped tournament data: ${result.fieldSize} players`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=43200' // 12 hours
      },
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Tournament fetch error:', error.message);
    console.error('Stack:', error.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to fetch tournament data',
        message: error.message,
        tour: event.queryStringParameters?.tour || 'pga'
      })
    };
  }
};
