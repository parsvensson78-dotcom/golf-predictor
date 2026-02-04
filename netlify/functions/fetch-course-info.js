const axios = require('axios');

/**
 * Fetch course information from DataGolf API and enrich with detailed course database
 * Combines real-time DataGolf data with comprehensive course characteristics
 * UPDATED: Expanded DP World Tour coverage for 2026 season
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
      
      // Add detailed course characteristics from database if available
      // But always prefer DataGolf's par and yardage since you have paid access
      width: courseDetails?.width || 'Information not available',
      greens: courseDetails?.greens || 'Information not available',
      rough: courseDetails?.rough || 'Information not available',
      keyFeatures: courseDetails?.keyFeatures || [],
      difficulty: courseDetails?.difficulty || null,
      rewards: courseDetails?.rewards || [],
      avgScore: courseDetails?.avgScore || null,
      
      source: courseDetails ? 'DataGolf API + Course Database' : 'DataGolf API'
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
 * UPDATED: Massively expanded DP World Tour coverage for 2026
 */
function getCourseDetails(courseNameFromDataGolf, tournamentName) {
  if (!courseNameFromDataGolf) return null;
  
  const courseName = courseNameFromDataGolf.toLowerCase();
  
  // Comprehensive course database - EXPANDED FOR 2026 DP WORLD TOUR
  const courseDatabase = {
    // ===== PGA TOUR - WEST COAST =====
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

    // ===== DP WORLD TOUR - MIDDLE EAST & ASIA (2026) =====
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
    
    'dubai creek': {
      name: 'Dubai Creek Golf & Yacht Club',
      yardage: 7301,
      par: 72,
      width: 'Wide fairways with water hazards',
      greens: 'Large paspalum greens',
      rough: 'Light desert rough',
      keyFeatures: ['Creek runs through course', 'Water on multiple holes', 'Dubai skyline backdrop', 'Strategic design'],
      difficulty: 'Moderate',
      rewards: ['Course management', 'Iron play', 'Putting', 'Distance control'],
      avgScore: 71.2
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
    
    'yas links': {
      name: 'Yas Links Abu Dhabi',
      yardage: 7450,
      par: 72,
      width: 'Wide links-style fairways',
      greens: 'Large paspalum greens',
      rough: 'Links-style rough',
      keyFeatures: ['Kyle Phillips design', 'Links golf in desert', 'Wind factor', 'Strategic bunkering'],
      difficulty: 'Difficult',
      rewards: ['Wind play', 'Links strategy', 'Ball control', 'Course management'],
      avgScore: 71.8
    },

    // ===== DP WORLD TOUR - AUSTRALIA & AFRICA (2026) =====
    'royal queensland': {
      name: 'Royal Queensland Golf Club',
      yardage: 7109,
      par: 72,
      width: 'Tree-lined parkland fairways',
      greens: 'Fast bentgrass greens',
      rough: 'Dense rough',
      keyFeatures: ['Historic Brisbane venue', 'Tight tree-lined holes', 'Quality test', 'Traditional design'],
      difficulty: 'Difficult',
      rewards: ['Accuracy off tee', 'Iron precision', 'Putting', 'Course management'],
      avgScore: 71.5
    },
    
    'royal melbourne': {
      name: 'Royal Melbourne Golf Club (West Course)',
      yardage: 6938,
      par: 71,
      width: 'Strategic fairways with heavy bunkering',
      greens: 'Fast, firm bent/poa greens',
      rough: 'Couch grass rough',
      keyFeatures: ['Alister MacKenzie design', 'World top-10 course', 'Strategic bunkering', 'Fast, firm conditions'],
      difficulty: 'Very difficult',
      rewards: ['Strategic thinking', 'Ball striking', 'Short game', 'Green reading'],
      avgScore: 70.5
    },
    
    'gary player cc': {
      name: 'Gary Player Country Club',
      yardage: 7831,
      par: 72,
      width: 'Wide fairways with strategic design',
      greens: 'Large, undulating bent greens',
      rough: 'Kikuyu rough',
      keyFeatures: ['Gary Player design', 'Altitude advantage', 'Water hazards', 'Spectacular setting'],
      difficulty: 'Difficult',
      rewards: ['Distance off tee', 'Iron accuracy', 'Green reading', 'Course strategy'],
      avgScore: 71.5
    },
    
    'heritage': {
      name: 'Heritage Golf Club, Mauritius',
      yardage: 7481,
      par: 72,
      width: 'Wide tropical fairways',
      greens: 'Large paspalum greens',
      rough: 'Tropical rough',
      keyFeatures: ['Peter Matkovich design', 'Tropical setting', 'Water features', 'Ocean views'],
      difficulty: 'Moderate',
      rewards: ['Distance', 'Approach play', 'Putting', 'Aggressive strategy'],
      avgScore: 70.8
    },

    // ===== DP WORLD TOUR - EUROPE (2026) =====
    'wentworth': {
      name: 'Wentworth Club (West Course)',
      yardage: 7302,
      par: 72,
      width: 'Tree-lined, strategic fairways',
      greens: 'Bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Ernie Els redesign', 'Historic venue', 'BMW PGA Championship host', 'Strategic design'],
      difficulty: 'Difficult',
      rewards: ['Ball striking', 'Iron precision', 'Course management', 'Mental toughness'],
      avgScore: 71.2
    },
    
    'old course': {
      name: 'Old Course at St Andrews',
      yardage: 7305,
      par: 72,
      width: 'Wide with strategic positioning crucial',
      greens: 'Massive double greens, firm fescue',
      rough: 'Heavy fescue rough',
      keyFeatures: ['Home of golf', 'Road Hole 17th', 'Hell Bunker', 'Strategic routing'],
      difficulty: 'Very difficult',
      rewards: ['Strategic thinking', 'Wind play', 'Green reading', 'Course knowledge'],
      avgScore: 71.8
    },
    
    'carnoustie': {
      name: 'Carnoustie Golf Links',
      yardage: 7421,
      par: 71,
      width: 'Relatively wide with penal rough',
      greens: 'Small, firm fescue greens',
      rough: 'Extremely penal fescue rough',
      keyFeatures: ['Carnoustie burn hazard', 'Brutal 18th hole', 'Unforgiving rough', 'Wind exposure'],
      difficulty: 'Extremely difficult',
      rewards: ['Accuracy', 'Mental toughness', 'Wind management', 'Ball striking'],
      avgScore: 72.5
    },
    
    'kingsbarns': {
      name: 'Kingsbarns Golf Links',
      yardage: 7227,
      par: 72,
      width: 'Generous fairways with strategic features',
      greens: 'Large fescue greens',
      rough: 'Fescue rough',
      keyFeatures: ['Coastal views', 'Modern links design', 'Risk-reward holes', 'Spectacular setting'],
      difficulty: 'Moderate',
      rewards: ['Aggressive play', 'Green reading', 'Strategic thinking', 'Putting'],
      avgScore: 70.5
    },
    
    'villa de madrid': {
      name: 'Club de Campo Villa de Madrid',
      yardage: 7180,
      par: 71,
      width: 'Tree-lined parkland fairways',
      greens: 'Bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Javier Arana design', 'Traditional Spanish venue', 'Strategic design', 'Mature trees'],
      difficulty: 'Difficult',
      rewards: ['Accuracy', 'Iron play', 'Course management', 'Scrambling'],
      avgScore: 70.8
    },
    
    'delhi': {
      name: 'Delhi Golf Club',
      yardage: 7259,
      par: 72,
      width: 'Tree-lined parkland fairways',
      greens: 'Large bentgrass greens',
      rough: 'Heavy rough',
      keyFeatures: ['Historic Indian venue', 'Peacocks on course', 'Mature trees', 'Traditional design'],
      difficulty: 'Difficult',
      rewards: ['Accuracy off tee', 'Iron precision', 'Putting', 'Mental game'],
      avgScore: 71.2
    },
    
    'doonbeg': {
      name: 'Trump International Golf Links Ireland, Doonbeg',
      yardage: 7250,
      par: 72,
      width: 'Wide links fairways with dunes',
      greens: 'Fescue greens',
      rough: 'Heavy dune rough',
      keyFeatures: ['Dramatic coastal setting', 'Martin Hawtree design', 'Massive dunes', 'Wind challenge'],
      difficulty: 'Very difficult',
      rewards: ['Wind management', 'Links strategy', 'Ball control', 'Mental toughness'],
      avgScore: 72.0
    },
    
    'stellenbosch': {
      name: 'Stellenbosch Golf Club',
      yardage: 7272,
      par: 72,
      width: 'Tree-lined parkland',
      greens: 'Kikuyu greens',
      rough: 'Kikuyu rough',
      keyFeatures: ['Winelands setting', 'Mountain backdrop', 'Strategic water', 'Mature oaks'],
      difficulty: 'Moderate',
      rewards: ['Accuracy', 'Iron play', 'Putting', 'Course management'],
      avgScore: 71.0
    },
    
    'houghton': {
      name: 'Houghton Golf Club',
      yardage: 7606,
      par: 72,
      width: 'Parkland with tree-lined fairways',
      greens: 'Kikuyu greens',
      rough: 'Kikuyu rough',
      keyFeatures: ['Altitude advantage', 'Historic Johannesburg venue', 'Strategic design', 'Mature trees'],
      difficulty: 'Moderate',
      rewards: ['Distance', 'Iron accuracy', 'Putting', 'Strategic play'],
      avgScore: 70.5
    }
  };
  
  // Try to match course name with improved matching
  for (const [key, details] of Object.entries(courseDatabase)) {
    const keyWords = key.split(' ');
    const courseWords = courseName.split(' ');
    
    // Match if any significant word matches
    if (courseName.includes(key) || 
        key.includes(courseWords[0]) ||
        keyWords.some(kw => courseWords.includes(kw))) {
      console.log(`[COURSE] ✅ Matched course database: "${courseName}" → ${key} → ${details.name}`);
      return details;
    }
  }
  
  console.log(`[COURSE] ❌ No course database match for: ${courseNameFromDataGolf}`);
  return null;
}

/**
 * Get course details by tournament name (fallback when DataGolf tournament not found)
 * UPDATED: Added 2026 DP World Tour tournaments
 */
function getCourseDetailsByTournamentName(tournamentName) {
  const name = tournamentName.toLowerCase();
  
  const tournamentToCourse = {
    // PGA TOUR
    'farmers': 'torrey pines',
    'pebble': 'pebble beach',
    'genesis': 'riviera',
    'phoenix': 'tpc scottsdale',
    'waste management': 'tpc scottsdale',
    
    // DP WORLD TOUR - Middle East
    'bahrain': 'royal gc',
    'bapco': 'royal gc',
    'dubai desert': 'emirates',
    'hero dubai': 'emirates',
    'dubai invitational': 'dubai creek',
    'dp world tour championship': 'earth course',
    'abu dhabi': 'yas links',
    
    // DP WORLD TOUR - Australia & Africa
    'australian pga': 'royal queensland',
    'australian open': 'royal melbourne',
    'nedbank': 'gary player cc',
    'mauritius': 'heritage',
    
    // DP WORLD TOUR - Europe
    'bmw pga': 'wentworth',
    'dunhill links': 'old course',
    'alfred dunhill': 'old course',
    'open de espana': 'villa de madrid',
    'india championship': 'delhi',
    'irish open': 'doonbeg',
    'amgen irish': 'doonbeg',
    'south african open': 'stellenbosch',
    'joburg': 'houghton'
  };
  
  for (const [key, courseKey] of Object.entries(tournamentToCourse)) {
    if (name.includes(key)) {
      const details = getCourseDetails(courseKey, tournamentName);
      if (details) {
        console.log(`[COURSE] ✅ Found course via tournament name: "${tournamentName}" → ${courseKey}`);
        return details;
      }
    }
  }
  
  console.log(`[COURSE] ❌ No tournament→course mapping for: ${tournamentName}`);
  return null;
}
