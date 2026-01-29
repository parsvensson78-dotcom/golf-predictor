const axios = require('axios');

/**
 * Fetch course information from DataGolf API and enrich with detailed course database
 * Combines real-time DataGolf data with comprehensive course characteristics
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

    // STEP 1: Fetch real-time data from DataGolf
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
      console.log(`[COURSE] Tournament not found in DataGolf, using course database only`);
      
      // Try to find course info from our database based on tournament name
      const courseDetails = getCourseDetailsByTournamentName(tournamentName);
      
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          eventName: tournamentName,
          courseName: courseDetails ? courseDetails.name : 'Course information not available',
          location: 'Location not available',
          source: 'Course Database (DataGolf tournament not found)',
          ...courseDetails
        })
      };
    }

    console.log(`[COURSE] Found tournament: ${tournament.event_name}`);
    console.log(`[COURSE] DataGolf course: ${tournament.course}`);

    // STEP 2: Extract DataGolf real-time data
    const dataGolfInfo = {
      eventId: tournament.event_id || null,
      eventName: tournament.event_name || null,
      calendarYear: tournament.calendar_year || null,
      courseName: tournament.course || null,
      courseKey: tournament.course_key || null,
      location: tournament.location || null,
      city: tournament.city || null,
      state: tournament.state || null,
      country: tournament.country || null,
      latitude: tournament.latitude || null,
      longitude: tournament.longitude || null,
      startDate: tournament.start_date || tournament.date || null,
      endDate: tournament.end_date || null,
      status: tournament.status || null,
      tour: tournament.tour || null,
      winner: tournament.winner || null,
      purse: tournament.purse || null,
      par: tournament.par || null,
      yardage: tournament.yardage || null
    };

    // STEP 3: Enrich with detailed course characteristics from database
    const courseDetails = getCourseDetails(tournament.course, tournament.event_name);

    // STEP 4: Merge DataGolf data with course database
    const enrichedCourseInfo = {
      ...dataGolfInfo,
      
      // Add detailed course characteristics (prefer database values, fallback to DataGolf)
      yardage: courseDetails?.yardage || dataGolfInfo.yardage,
      par: courseDetails?.par || dataGolfInfo.par,
      width: courseDetails?.width || null,
      greens: courseDetails?.greens || null,
      rough: courseDetails?.rough || null,
      keyFeatures: courseDetails?.keyFeatures || [],
      difficulty: courseDetails?.difficulty || null,
      rewards: courseDetails?.rewards || [],
      avgScore: courseDetails?.avgScore || null,
      
      source: courseDetails ? 'DataGolf API + Course Database' : 'DataGolf API Only'
    };

    console.log(`[COURSE] Enriched course info for: ${enrichedCourseInfo.courseName}`);
    console.log(`[COURSE] Par: ${enrichedCourseInfo.par}, Yardage: ${enrichedCourseInfo.yardage}`);
    console.log(`[COURSE] Source: ${enrichedCourseInfo.source}`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400' // Cache for 24 hours
      },
      body: JSON.stringify(enrichedCourseInfo)
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
        eventName: 'Course information unavailable',
        courseName: 'Unknown',
        location: 'Unknown',
        yardage: null,
        par: null,
        source: 'Error fallback',
        error: error.message
      })
    };
  }
};

/**
 * Get detailed course characteristics from database
 * Matches course name from DataGolf to our comprehensive database
 */
function getCourseDetails(courseNameFromDataGolf, tournamentName) {
  if (!courseNameFromDataGolf) return null;
  
  const courseName = courseNameFromDataGolf.toLowerCase();
  
  // Comprehensive course database
  const courseDatabase = {
    // PGA TOUR - WEST COAST
    'torrey pines': {
      name: 'Torrey Pines Golf Course (South Course)',
      yardage: 7765,
      par: 72,
      width: 'Moderate width, coastal terrain',
      greens: 'Poa annua, can be bumpy',
      rough: 'Heavy kikuyu rough',
      keyFeatures: ['Longest course on tour', 'Coastal winds', 'Kikuyu rough is penal', 'Public course'],
      difficulty: 'Very difficult',
      rewards: ['Distance critical', 'Power off tee', 'Scrambling from kikuyu', 'Wind play'],
      avgScore: 73.1
    },
    
    'pebble beach': {
      name: 'Pebble Beach Golf Links',
      yardage: 7075,
      par: 72,
      width: 'Narrow fairways with coastal cliffs',
      greens: 'Small, Poa annua greens',
      rough: 'Heavy kikuyu rough',
      keyFeatures: ['Iconic coastal holes', 'Wind is critical factor', 'Short game demands high', 'Poa annua putting'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Scrambling ability', 'Wind management', 'Short game excellence'],
      avgScore: 72.5
    },
    
    'spyglass': {
      name: 'Spyglass Hill Golf Course',
      yardage: 7041,
      par: 72,
      width: 'Narrow, tree-lined inland holes',
      greens: 'Small, Poa annua greens',
      rough: 'Heavy kikuyu and pine straw',
      keyFeatures: ['Mix of coastal and forest holes', 'Tough opening stretch', 'Demanding par 3s', 'Strategic design'],
      difficulty: 'Very difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental strength'],
      avgScore: 73.2
    },
    
    'monterey peninsula': {
      name: 'Monterey Peninsula Country Club (Shore Course)',
      yardage: 6958,
      par: 71,
      width: 'Moderate width with coastal exposure',
      greens: 'Poa annua greens',
      rough: 'Kikuyu rough',
      keyFeatures: ['Coastal holes', 'Wind factor', 'Scenic views', 'Short but challenging'],
      difficulty: 'Difficult',
      rewards: ['Wind play', 'Short game', 'Course management', 'Accuracy'],
      avgScore: 71.8
    },
    
    'riviera': {
      name: 'Riviera Country Club',
      yardage: 7322,
      par: 71,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, firm Kikuyu/Poa mix',
      rough: 'Thick kikuyu rough',
      keyFeatures: ['Classic architecture', 'Barranca hazards', 'Elevated greens', 'Strategic bunkering'],
      difficulty: 'Very difficult',
      rewards: ['Ball striking', 'Iron precision', 'Scrambling ability', 'Course management'],
      avgScore: 71.2
    },
    
    'tpc scottsdale': {
      name: 'TPC Scottsdale (Stadium Course)',
      yardage: 7261,
      par: 71,
      width: 'Wide desert fairways',
      greens: 'Large, overseeded Bermuda greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Famous 16th hole', 'Stadium atmosphere', 'Scoring opportunities', 'Desert target golf'],
      difficulty: 'Moderate',
      rewards: ['Aggressive play', 'Birdie-making', 'Iron accuracy', 'Putting'],
      avgScore: 68.5
    },
    
    'la quinta': {
      name: 'La Quinta Country Club',
      yardage: 7060,
      par: 72,
      width: 'Wide, generous fairways',
      greens: 'Large, receptive Bermuda greens',
      rough: 'Light desert rough',
      keyFeatures: ['Desert target golf', 'Strategic water hazards', 'Pete Dye design', 'Scoring opportunities'],
      difficulty: 'Moderate',
      rewards: ['Aggressive approach play', 'Birdie-making ability', 'Strong iron game', 'Putting confidence'],
      avgScore: 70.2
    },
    
    'pga west': {
      name: 'PGA West Stadium Course',
      yardage: 7300,
      par: 72,
      width: 'Wide with strategic hazards',
      greens: 'Large, undulating Bermuda greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Stadium atmosphere', 'Island greens', 'Water hazards', 'Risk-reward holes'],
      difficulty: 'Difficult',
      rewards: ['Course management', 'Iron precision', 'Mental toughness', 'Scrambling'],
      avgScore: 71.8
    },
    
    // PGA TOUR - HAWAII
    'kapalua': {
      name: 'Kapalua Plantation Course',
      yardage: 7596,
      par: 73,
      width: 'Wide, generous fairways',
      greens: 'Large, undulating Bermuda greens',
      rough: 'Light rough with native areas',
      keyFeatures: ['Extreme elevation changes', 'Trade winds critical', 'Wide landing areas', 'Long par 5s'],
      difficulty: 'Moderate',
      rewards: ['Distance off tee', 'Wind play', 'Long iron accuracy', 'Green reading'],
      avgScore: 72.5
    },
    
    'waialae': {
      name: 'Waialae Country Club',
      yardage: 7044,
      par: 70,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, firm Bermuda greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Short but tight', 'Frequent trade winds', 'Small greens premium', 'Birdie-fest potential'],
      difficulty: 'Moderate',
      rewards: ['Accuracy off tee', 'Wedge play', 'Wind management', 'Putting excellence'],
      avgScore: 68.8
    },
    
    // PGA TOUR - FLORIDA
    'pga national': {
      name: 'PGA National (Champion Course)',
      yardage: 7140,
      par: 70,
      width: 'Moderate width with water',
      greens: 'Firm, fast Bermuda greens',
      rough: 'Bermuda rough',
      keyFeatures: ['Bear Trap holes 15-17', 'Water on 16 holes', 'Wind critical', 'Tough stretch finish'],
      difficulty: 'Very difficult',
      rewards: ['Mental toughness', 'Wind play', 'Iron control', 'Scrambling'],
      avgScore: 70.8
    },
    
    'bay hill': {
      name: 'Arnold Palmer Bay Hill Club & Lodge',
      yardage: 7466,
      par: 72,
      width: 'Moderate width with water hazards',
      greens: 'Firm, fast Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['Water on multiple holes', 'Arnold Palmer redesign', 'Tough closing stretch', 'Wind factor'],
      difficulty: 'Very difficult',
      rewards: ['Distance control', 'Iron play', 'Mental toughness', 'Scrambling'],
      avgScore: 72.8
    },
    
    'tpc sawgrass': {
      name: 'TPC Sawgrass (Stadium Course)',
      yardage: 7256,
      par: 72,
      width: 'Narrow, target-style fairways',
      greens: 'Firm, fast Bermuda greens',
      rough: 'Bermuda rough with waste areas',
      keyFeatures: ['Island 17th green', 'Water hazards on 10+ holes', 'Strategic bunkering', 'Stadium atmosphere'],
      difficulty: 'Extremely difficult',
      rewards: ['Iron precision', 'Course management', 'Mental toughness', 'Ball striking'],
      avgScore: 72.2
    },
    
    'innisbrook': {
      name: 'Innisbrook Resort (Copperhead Course)',
      yardage: 7340,
      par: 71,
      width: 'Narrow, heavily tree-lined',
      greens: 'Small, elevated Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['No water hazards', 'Copperhead challenges', 'Elevated greens', 'Strategic bunkering'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Approach play', 'Scrambling', 'Ball striking'],
      avgScore: 71.5
    },
    
    // PGA TOUR - MAJORS & SPECIAL
    'augusta national': {
      name: 'Augusta National Golf Club',
      yardage: 7510,
      par: 72,
      width: 'Moderate width with strategic positioning',
      greens: 'Exceptionally fast, undulating bentgrass',
      rough: 'Light rough, pine straw',
      keyFeatures: ['Extreme green slopes', 'Amen Corner', 'Second-shot golf course', 'Fast, firm conditions'],
      difficulty: 'Very difficult',
      rewards: ['Distance and trajectory control', 'Iron play', 'Green reading', 'Mental game'],
      avgScore: 71.8
    },
    
    'harbour town': {
      name: 'Harbour Town Golf Links',
      yardage: 7191,
      par: 71,
      width: 'Narrow, tree-lined fairways',
      greens: 'Small, firm Bermuda greens',
      rough: 'Heavy Bermuda rough',
      keyFeatures: ['Pete Dye design', 'Narrow fairways', 'Precision over power', 'Iconic lighthouse'],
      difficulty: 'Very difficult',
      rewards: ['Accuracy off tee', 'Iron precision', 'Course management', 'Short game'],
      avgScore: 70.8
    },
    
    'muirfield village': {
      name: 'Muirfield Village Golf Club',
      yardage: 7543,
      par: 72,
      width: 'Moderate width with strategic design',
      greens: 'Firm, fast bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Jack Nicklaus design', 'Strategic water hazards', 'Premium on accuracy', 'Difficult par 3s'],
      difficulty: 'Very difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental game'],
      avgScore: 71.8
    },
    
    'tpc river highlands': {
      name: 'TPC River Highlands',
      yardage: 6841,
      par: 70,
      width: 'Narrow, tight fairways',
      greens: 'Small, firm bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Short course', 'Precision required', 'Scoring opportunities', 'Strategic water'],
      difficulty: 'Moderate',
      rewards: ['Accuracy off tee', 'Iron precision', 'Birdie-making', 'Short game'],
      avgScore: 67.5
    },
    
    // DP WORLD TOUR - MIDDLE EAST
    'royal gc': {
      name: 'Royal Golf Club',
      yardage: 7428,
      par: 72,
      width: 'Wide fairways with strategic bunkering',
      greens: 'Firm paspalum greens',
      rough: 'Light desert rough',
      keyFeatures: ['Desert golf', 'Strategic water hazards', 'Firm, fast conditions', 'Modern design'],
      difficulty: 'Moderate',
      rewards: ['Distance off tee', 'Approach play accuracy', 'Putting on fast greens', 'Course management'],
      avgScore: 71.0
    },
    
    'al hamra': {
      name: 'Al Hamra Golf Club',
      yardage: 7322,
      par: 72,
      width: 'Wide fairways with desert landscape',
      greens: 'Large, firm paspalum greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Coastal setting', 'Risk-reward design', 'Strategic bunkering', 'Wind factor'],
      difficulty: 'Moderate',
      rewards: ['Aggressive play', 'Distance advantage', 'Iron accuracy', 'Putting'],
      avgScore: 71.2
    },
    
    'emirates': {
      name: 'Majlis Course at Emirates Golf Club',
      yardage: 7301,
      par: 72,
      width: 'Wide fairways with strategic bunkering',
      greens: 'Elevated, firm paspalum greens',
      rough: 'Light desert rough',
      keyFeatures: ['Iconic Dubai skyline views', 'Elevated greens demand precision', 'Strategic water hazards', 'Firm, fast desert conditions'],
      difficulty: 'Difficult',
      rewards: ['Approach play accuracy', 'Putting on fast greens', 'Iron precision', 'Course management'],
      avgScore: 71.5
    },
    
    'earth course': {
      name: 'Earth Course at Jumeirah Golf Estates',
      yardage: 7681,
      par: 72,
      width: 'Wide desert fairways',
      greens: 'Large, undulating paspalum greens',
      rough: 'Desert rough and waste areas',
      keyFeatures: ['Greg Norman design', 'Desert landscape', 'Strategic water', 'Wide landing areas'],
      difficulty: 'Moderate',
      rewards: ['Distance advantage', 'Aggressive play', 'Iron game', 'Putting'],
      avgScore: 71.0
    },
    
    // DP WORLD TOUR - EUROPE
    'wentworth': {
      name: 'Wentworth Club (West Course)',
      yardage: 7302,
      par: 72,
      width: 'Tree-lined, strategic fairways',
      greens: 'Bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Ernie Els redesign', 'Historic venue', 'Strategic design', 'BMW PGA Championship'],
      difficulty: 'Difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental toughness'],
      avgScore: 71.2
    }
  };
  
  // Try to match course name
  for (const [key, details] of Object.entries(courseDatabase)) {
    if (courseName.includes(key) || key.includes(courseName.split(' ')[0])) {
      console.log(`[COURSE] Matched course database: ${key} → ${details.name}`);
      return details;
    }
  }
  
  console.log(`[COURSE] No course database match for: ${courseNameFromDataGolf}`);
  return null;
}

/**
 * Get course details by tournament name (fallback when DataGolf tournament not found)
 */
function getCourseDetailsByTournamentName(tournamentName) {
  const name = tournamentName.toLowerCase();
  
  const tournamentToCourse = {
    'farmers': 'torrey pines',
    'torrey': 'torrey pines',
    'pebble': 'pebble beach',
    'genesis': 'riviera',
    'riviera': 'riviera',
    'phoenix': 'tpc scottsdale',
    'waste management': 'tpc scottsdale',
    'american express': 'la quinta',
    'kapalua': 'kapalua',
    'sentry': 'kapalua',
    'sony': 'waialae',
    'honda': 'pga national',
    'arnold palmer': 'bay hill',
    'players': 'tpc sawgrass',
    'valspar': 'innisbrook',
    'masters': 'augusta national',
    'heritage': 'harbour town',
    'memorial': 'muirfield village',
    'travelers': 'tpc river highlands',
    'bahrain': 'royal gc',
    'ras al khaimah': 'al hamra',
    'dubai': 'emirates',
    'dp world': 'earth course'
  };
  
  for (const [key, courseKey] of Object.entries(tournamentToCourse)) {
    if (name.includes(key)) {
      const details = getCourseDetails(courseKey, tournamentName);
      if (details) {
        console.log(`[COURSE] Found course via tournament name: ${tournamentName} → ${courseKey}`);
        return details;
      }
    }
  }
  
  return null;
}
