const axios = require('axios');

/**
 * Fetch course information from DataGolf API
 * Returns course details for the current tournament
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const tournamentName = event.queryStringParameters?.tournament || '';
    
    console.log(`[COURSE] Fetching course info for: ${tournamentName} (${tour.toUpperCase()} tour)`);

    // DataGolf API key
    const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';

    // Convert tour parameter
    const apiTour = tour === 'dp' ? 'euro' : tour;

    // Fetch course data from DataGolf
    // DataGolf provides course info in their field-updates and schedule endpoints
    const scheduleUrl = `https://feeds.datagolf.com/get-schedule?tour=${apiTour}&file_format=json&key=${DATAGOLF_API_KEY}`;
    
    console.log(`[COURSE] Fetching schedule from DataGolf...`);
    
    const response = await axios.get(scheduleUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    if (!response.data || !response.data.schedule) {
      throw new Error('Invalid schedule response from DataGolf');
    }

    // Find the current tournament
    const tournaments = Array.isArray(response.data.schedule) 
      ? response.data.schedule 
      : Object.values(response.data.schedule);

    console.log(`[COURSE] Searching through ${tournaments.length} tournaments for: ${tournamentName}`);

    // Find matching tournament by name
    const tournament = tournaments.find(t => {
      const eventName = (t.event_name || '').toLowerCase();
      const searchName = tournamentName.toLowerCase();
      return eventName.includes(searchName) || searchName.includes(eventName.split(' ')[0]);
    });

    if (!tournament) {
      console.log(`[COURSE] Tournament not found, returning generic data`);
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: tournamentName,
          course: tournament?.course || 'Course information not available',
          yardage: null,
          par: null,
          location: tournament?.location || 'Location not available',
          source: 'Generic (tournament not found)'
        })
      };
    }

    console.log(`[COURSE] Found tournament: ${tournament.event_name}`);
    console.log(`[COURSE] Raw tournament data:`, JSON.stringify(tournament, null, 2));

    // Build comprehensive course info from ALL available DataGolf data
    const courseInfo = {
      // Tournament identification
      eventId: tournament.event_id || null,
      eventName: tournament.event_name || null,
      calendarYear: tournament.calendar_year || null,
      
      // Course information
      courseName: tournament.course || null,
      courseKey: tournament.course_key || null,
      
      // Location data
      location: tournament.location || null,
      city: tournament.city || null,
      state: tournament.state || null,
      country: tournament.country || null,
      latitude: tournament.latitude || null,
      longitude: tournament.longitude || null,
      
      // Tournament details
      startDate: tournament.start_date || tournament.date || null,
      endDate: tournament.end_date || null,
      status: tournament.status || null,
      tour: tournament.tour || null,
      
      // Winner information (if available)
      winner: tournament.winner || null,
      
      // Purse/Money (if available)
      purse: tournament.purse || null,
      
      // Course statistics (if available)
      par: tournament.par || null,
      yardage: tournament.yardage || null,
      
      // Any other fields that might exist
      ...tournament,
      
      source: 'DataGolf API (Complete)'
    };

    console.log(`[COURSE] Extracted course info:`, JSON.stringify(courseInfo, null, 2));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400' // Cache for 24 hours
      },
      body: JSON.stringify(courseInfo)
    };

  } catch (error) {
    console.error('[COURSE] Error fetching course info:', error.message);
    if (error.response) {
      console.error('[COURSE] API Response Status:', error.response.status);
      console.error('[COURSE] API Response Data:', JSON.stringify(error.response.data));
    }

    // Return minimal data on error
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Course information unavailable',
        course: 'Unknown',
        location: 'Unknown',
        source: 'Error fallback',
        error: error.message
      })
    };
  }
};
