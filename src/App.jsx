import React, { useState, useCallback } from 'react';
import './App.css';

/**
 * OPTIMIZED App.jsx
 * - Extracted reusable components
 * - Reduced code duplication
 * - Better state management
 * - Cleaner structure
 */

function App() {
  const [tour, setTour] = useState('pga');
  const [activeTab, setActiveTab] = useState('predictions');
  const [data, setData] = useState({
    predictions: null,
    avoidPicks: null,
    newsPreview: null,
    matchups: null,
    results: null
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requestId, setRequestId] = useState(0);

  // Generic fetch function to avoid duplication
  const fetchData = useCallback(async (endpoint, method = 'GET', body = null, dataKey) => {
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    setError(null);
    setLoading(true);
    
    try {
      const timestamp = Date.now();
      const options = {
        method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
      };
      
      if (body) {
        options.body = JSON.stringify({ ...body, _: timestamp });
      }
      
      const url = method === 'GET' 
        ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}_=${timestamp}`
        : endpoint;
      
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Request failed');
      }
      
      const responseData = await response.json();
      setData(prev => ({ ...prev, [dataKey]: responseData }));
      
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  const handleGetPredictions = () => 
    fetchData(`/.netlify/functions/get-predictions?tour=${tour}`, 'GET', null, 'predictions');
  
  const handleGetAvoidPicks = () => 
    fetchData(`/.netlify/functions/get-avoid-picks`, 'POST', { tour }, 'avoidPicks');
  
  const handleGetNews = () => 
    fetchData(`/.netlify/functions/get-tournament-news?tour=${tour}`, 'GET', null, 'newsPreview');
  
  const handleGetMatchups = () => 
    fetchData(`/.netlify/functions/get-matchup-predictions`, 'POST', { tour }, 'matchups');

  const handleGetResults = () => 
    fetchData(`/.netlify/functions/get-prediction-results`, 'GET', null, 'results');

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setData({ predictions: null, avoidPicks: null, newsPreview: null, matchups: null, results: null });
    setError(null);
    setRequestId(prev => prev + 1);
  };

  const currentData = data[
    activeTab === 'predictions' ? 'predictions' :
    activeTab === 'avoid' ? 'avoidPicks' :
    activeTab === 'news' ? 'newsPreview' : 
    activeTab === 'results' ? 'results' : 'matchups'
  ];

  return (
    <div className="app">
      <Header />
      
      <TourSelector tour={tour} onTourChange={handleTourChange} disabled={loading} />
      
      <TabSelector activeTab={activeTab} onTabChange={setActiveTab} disabled={loading} />
      
      <ActionButton 
        activeTab={activeTab}
        loading={loading}
        onGetPredictions={handleGetPredictions}
        onGetAvoidPicks={handleGetAvoidPicks}
        onGetNews={handleGetNews}
        onGetMatchups={handleGetMatchups}
        onGetResults={handleGetResults}
      />

      {loading && <LoadingState requestId={requestId} />}
      
      {error && !loading && <ErrorState error={error} onRetry={handleGetPredictions} requestId={requestId} />}

      {currentData && !loading && !error && (
        <>
          {activeTab === 'predictions' && <PredictionsView data={currentData} requestId={requestId} />}
          {activeTab === 'avoid' && <AvoidPicksView data={currentData} requestId={requestId} />}
          {activeTab === 'news' && <NewsPreviewView data={currentData} requestId={requestId} />}
          {activeTab === 'matchups' && <MatchupsView data={currentData} requestId={requestId} />}
          {activeTab === 'results' && <ResultsView data={currentData} requestId={requestId} />}
        </>
      )}
    </div>
  );
}

// ==================== HEADER ====================
const Header = () => (
  <header className="header">
    <h1>🏌️ Golf AI Predictor</h1>
    <p className="subtitle">Complete field analysis • Course-fit value picks • AI powered</p>
  </header>
);

// ==================== TOUR SELECTOR ====================
const TourSelector = ({ tour, onTourChange, disabled }) => (
  <div className="tour-selector">
    <button 
      className={`tour-btn ${tour === 'pga' ? 'active' : ''}`}
      onClick={() => onTourChange('pga')}
      disabled={disabled}
    >
      PGA Tour
    </button>
    <button 
      className={`tour-btn ${tour === 'dp' ? 'active' : ''}`}
      onClick={() => onTourChange('dp')}
      disabled={disabled}
    >
      DP World Tour
    </button>
  </div>
);

// ==================== TAB SELECTOR ====================
const TabSelector = ({ activeTab, onTabChange, disabled }) => (
  <div className="tab-selector">
    {[
      { id: 'predictions', icon: '📊', label: 'Value Predictions' },
      { id: 'avoid', icon: '❌', label: 'Avoid Picks' },
      { id: 'news', icon: '📰', label: 'News & Preview' },
      { id: 'matchups', icon: '🆚', label: 'Matchup Predictor' },
      { id: 'results', icon: '🏆', label: 'Results' }
    ].map(tab => (
      <button 
        key={tab.id}
        className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
        onClick={() => onTabChange(tab.id)}
        disabled={disabled}
      >
        {tab.icon} {tab.label}
      </button>
    ))}
  </div>
);

// ==================== ACTION BUTTON ====================
const ActionButton = ({ activeTab, loading, onGetPredictions, onGetAvoidPicks, onGetNews, onGetMatchups, onGetResults }) => {
  const buttonConfig = {
    predictions: { text: 'Get Predictions', handler: onGetPredictions },
    avoid: { text: 'Get Avoid Picks', handler: onGetAvoidPicks },
    news: { text: 'Get News & Preview', handler: onGetNews },
    matchups: { text: 'Get Matchup Predictions', handler: onGetMatchups },
    results: { text: 'Load Results History', handler: onGetResults }
  };

  const config = buttonConfig[activeTab];

  return (
    <div className="action-section">
      <button 
        className="get-predictions-btn"
        onClick={config.handler}
        disabled={loading}
      >
        {config.text}
      </button>
    </div>
  );
};

// ==================== LOADING STATE ====================
const LoadingState = ({ requestId }) => (
  <div className="loading" key={`loading-${requestId}`}>
    <div className="spinner"></div>
    <h3>Analyzing Tournament Data...</h3>
    <p className="loading-subtext">Fetching stats, odds, weather & generating AI predictions</p>
  </div>
);

// ==================== ERROR STATE ====================
const ErrorState = ({ error, onRetry, requestId }) => (
  <div className="error" key={`error-${requestId}`}>
    <h3>❌ Error</h3>
    <p>{error}</p>
    <button onClick={onRetry}>Try Again</button>
  </div>
);

// ==================== PREDICTIONS VIEW ====================
const PredictionsView = ({ data, requestId }) => (
  <div className="predictions-container" key={`predictions-${requestId}-${data.generatedAt}`}>
    <TournamentInfo tournament={data.tournament} />
    
    {data.dailyForecast?.length > 0 && <DailyWeatherForecast daily={data.dailyForecast} />}
    
    <CourseDetailsCard courseInfo={data.courseInfo} courseAnalysis={data.courseAnalysis} />
    
    <PredictionCards predictions={data.predictions} />
    
    <FooterInfo data={data} />
  </div>
);

// ==================== AVOID PICKS VIEW ====================
const AvoidPicksView = ({ data, requestId }) => (
  <div className="predictions-container" key={`avoid-${requestId}-${data.generatedAt}`}>
    <TournamentInfo tournament={data.tournament} />
    
    {data.dailyForecast?.length > 0 && <DailyWeatherForecast daily={data.dailyForecast} />}
    
    <CourseDetailsCard courseInfo={data.courseInfo} courseAnalysis={data.courseAnalysis} />
    
    <AvoidPicksCards picks={data.avoidPicks} />
    
    <FooterInfo data={data} />
  </div>
);

// ==================== TOURNAMENT INFO ====================
const TournamentInfo = ({ tournament }) => (
  <div className="tournament-info">
    <h2>{tournament.name}</h2>
    <div className="tournament-details">
      <span>🏌️ {tournament.course}</span>
      <span>📍 {tournament.location}</span>
      <span>📅 {tournament.dates}</span>
      <span>🌍 {tournament.tour === 'pga' ? 'PGA Tour' : 'DP World Tour'}</span>
    </div>
  </div>
);

// ==================== DAILY WEATHER FORECAST ====================
const DailyWeatherForecast = ({ daily }) => (
  <div className="weather-forecast-section">
    <h3>☀️ 4-Day Weather Forecast</h3>
    <div className="daily-forecast-grid">
      {daily.map((day, index) => (
        <div key={index} className="forecast-day-card">
          <div className="forecast-day-name">{day.day}</div>
          <div className="forecast-temp">
            <span className="temp-high">{day.tempHigh}°</span>
            <span className="temp-divider">/</span>
            <span className="temp-low">{day.tempLow}°</span>
          </div>
          <div className="forecast-condition">{day.condition}</div>
          <div className="forecast-details">
            <span className="forecast-wind">💨 {day.windSpeed}mph</span>
            <span className="forecast-rain">☔ {day.chanceOfRain}%</span>
          </div>
        </div>
      ))}
    </div>
  </div>
);

// ==================== COURSE DETAILS CARD ====================
const CourseDetailsCard = ({ courseInfo, courseAnalysis }) => {
  const hasBasicInfo = courseInfo.par || courseInfo.yardage || courseInfo.width || courseInfo.greens || courseInfo.rough;
  const hasDetailedInfo = courseInfo.keyFeatures?.length > 0 || courseInfo.rewards?.length > 0;
  
  if (!hasBasicInfo && !hasDetailedInfo) return null;

  return (
    <div className="course-details-card">
      <div className="course-header-section">
        <h3>⛳ {courseInfo.name || courseInfo.courseName || 'Course Details'}</h3>
        {courseInfo.difficulty && (
          <span className="difficulty-badge">{courseInfo.difficulty}</span>
        )}
      </div>

      {(courseInfo.par || courseInfo.yardage || courseInfo.avgScore) && (
        <div className="course-overview">
          <h4>📊 Course Statistics</h4>
          <div className="course-stats-grid">
            {courseInfo.par && (
              <div className="course-stat highlight">
                <div className="stat-label">Par</div>
                <div className="stat-value">{courseInfo.par}</div>
              </div>
            )}
            {courseInfo.yardage && (
              <div className="course-stat highlight">
                <div className="stat-label">Yardage</div>
                <div className="stat-value">{courseInfo.yardage.toLocaleString()}</div>
                <div className="stat-unit">yards</div>
              </div>
            )}
            {courseInfo.avgScore && (
              <div className="course-stat">
                <div className="stat-label">Avg Score</div>
                <div className="stat-value">{courseInfo.avgScore}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {(courseInfo.width || courseInfo.greens || courseInfo.rough) && (
        <div className="course-characteristics-detailed">
          <h4>🎯 Course Characteristics</h4>
          <div className="characteristics-grid">
            {courseInfo.width && (
              <div className="characteristic-card">
                <span className="char-icon">↔️</span>
                <div className="char-content">
                  <div className="char-label">Fairway Width</div>
                  <div className="char-value">{courseInfo.width}</div>
                </div>
              </div>
            )}
            {courseInfo.greens && (
              <div className="characteristic-card">
                <span className="char-icon">🟢</span>
                <div className="char-content">
                  <div className="char-label">Greens</div>
                  <div className="char-value">{courseInfo.greens}</div>
                </div>
              </div>
            )}
            {courseInfo.rough && (
              <div className="characteristic-card">
                <span className="char-icon">🌾</span>
                <div className="char-content">
                  <div className="char-label">Rough</div>
                  <div className="char-value">{courseInfo.rough}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {courseInfo.keyFeatures?.length > 0 && (
        <div className="key-features-detailed">
          <h4>🔑 Key Course Features</h4>
          <div className="features-grid">
            {courseInfo.keyFeatures.map((feature, index) => (
              <div key={index} className="feature-item-detailed">
                <span className="feature-bullet">•</span>
                <span>{feature}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {courseAnalysis && (
        <div className="course-analysis-section">
          <h4>🧠 AI Course Analysis</h4>
          {courseAnalysis.type && (
            <div className="analysis-block">
              <div className="analysis-subtitle">Course Type & Setup</div>
              <p>{courseAnalysis.type}</p>
            </div>
          )}
          {courseAnalysis.weatherImpact && (
            <div className="analysis-block">
              <div className="analysis-subtitle">Weather Impact</div>
              <p>{courseAnalysis.weatherImpact}</p>
            </div>
          )}
          {courseAnalysis.keyFactors?.length > 0 && (
            <div className="analysis-block">
              <div className="analysis-subtitle">Key Success Factors</div>
              <ul className="key-factors-list">
                {courseAnalysis.keyFactors.map((factor, index) => (
                  <li key={index}>{factor}</li>
                ))}
              </ul>
            </div>
          )}
          {courseAnalysis.notes && (
            <div className="analysis-block">
              <div className="analysis-subtitle">Additional Notes</div>
              <p>{courseAnalysis.notes}</p>
            </div>
          )}
        </div>
      )}

      {courseInfo.rewards?.length > 0 && (
        <div className="rewards-skills-detailed">
          <h4>💪 Skills Rewarded</h4>
          <div className="skills-tags">
            {courseInfo.rewards.map((skill, index) => (
              <span key={index} className="skill-tag-enhanced">{skill}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ==================== PREDICTION CARDS ====================
const PredictionCards = ({ predictions }) => (
  <div className="predictions-grid">
    {predictions.map((pick, index) => (
      <div key={index} className="prediction-card">
        <div className="pick-number">Pick #{index + 1}</div>
        <h3 className="player-name">{pick.player}</h3>
        <div className="odds-display">{Math.round(pick.odds)}/1</div>
        
        {(pick.minOdds || pick.maxOdds || pick.bestBookmaker) && (
          <div className="odds-breakdown">
            {pick.bestBookmaker && pick.maxOdds && (
              <div className="odds-breakdown-item">
                <span className="odds-breakdown-label">Best</span>
                <span className="odds-breakdown-value best">{Math.round(pick.maxOdds)}/1</span>
                <span className="odds-breakdown-book">{pick.bestBookmaker}</span>
              </div>
            )}
            {pick.odds && (
              <div className="odds-breakdown-item">
                <span className="odds-breakdown-label">Avg</span>
                <span className="odds-breakdown-value avg">{Math.round(pick.odds)}/1</span>
              </div>
            )}
            {pick.minOdds && (
              <div className="odds-breakdown-item">
                <span className="odds-breakdown-label">Worst</span>
                <span className="odds-breakdown-value worst">{Math.round(pick.minOdds)}/1</span>
              </div>
            )}
          </div>
        )}
        
        <p className="reasoning">{pick.reasoning}</p>
      </div>
    ))}
  </div>
);

// ==================== AVOID PICKS CARDS ====================
const AvoidPicksCards = ({ picks }) => (
  <div className="avoid-picks-section">
    <h3>❌ Players to Avoid This Week</h3>
    <p className="avoid-subtitle">Course mismatches • Recent form concerns • Statistical red flags</p>
    <div className="avoid-picks-grid">
      {picks.map((pick, index) => (
        <div key={index} className="avoid-card">
          <div className="avoid-header">
            <h4>{pick.player}</h4>
            <span className="avoid-odds">{Math.round(pick.odds)}/1</span>
          </div>
          <p className="avoid-reasoning">{pick.reasoning}</p>
        </div>
      ))}
    </div>
  </div>
);

// ==================== FOOTER INFO ====================
const FooterInfo = ({ data }) => (
  <div className="api-usage-info">
    <div className="token-info">
      💬 Tokens: {data.tokensUsed?.toLocaleString() || 'N/A'}
    </div>
    <div className="cost-info">
      💰 Cost: {data.estimatedCost || 'N/A'}
    </div>
  </div>
);

// ==================== NEWS PREVIEW VIEW ====================
const NewsPreviewView = ({ data, requestId }) => (
  <div className="news-preview-container" key={`news-${requestId}-${data.generatedAt}`}>
    <TournamentInfo tournament={data.tournament} />
    
    {data.preview && (
      <div className="ai-preview-section">
        <h3>🤖 AI Tournament Preview</h3>
        {data.preview.overview && (
          <div className="preview-overview">
            <p>{data.preview.overview}</p>
          </div>
        )}
        {/* Add other preview sections as needed */}
      </div>
    )}
    
    {data.news?.length > 0 && (
      <div className="news-articles-section">
        <h3>📰 Latest Golf News</h3>
        <div className="news-grid">
          {data.news.map((article, index) => (
            <div key={index} className="news-article-card">
              <div className="article-source">{article.source}</div>
              <h4 className="article-title">
                <a href={article.link} target="_blank" rel="noopener noreferrer">
                  {article.title}
                </a>
              </h4>
              {article.description && (
                <p className="article-description">{article.description}</p>
              )}
              <div className="article-date">
                {new Date(article.pubDate).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      </div>
    )}
    
    <FooterInfo data={data} />
  </div>
);

// ==================== MATCHUPS VIEW ====================
const MatchupsView = ({ data, requestId }) => (
  <div className="matchup-container" key={`matchup-${requestId}-${data.generatedAt}`}>
    <TournamentInfo tournament={data.tournament} />
    
    {data.suggestedMatchups?.length > 0 && (
      <div className="suggested-matchups-section">
        <h3>🆚 AI-Suggested Matchups</h3>
        <p className="matchup-subtitle">Head-to-head predictions based on stats and course fit</p>
        
        {data.suggestedMatchups.map((matchup, index) => (
          <div key={index} className="matchup-card">
            <div className="matchup-header">
              <span className="matchup-number">Matchup #{index + 1}</span>
              <span className={`confidence-badge confidence-${matchup.confidence.toLowerCase().replace('-', '')}`}>
                {matchup.confidence}
              </span>
            </div>
            <div className="matchup-players">
              <PlayerBox player={matchup.playerA} isPick={matchup.pick === matchup.playerA.name} />
              <div className="vs-divider">VS</div>
              <PlayerBox player={matchup.playerB} isPick={matchup.pick === matchup.playerB.name} />
            </div>
            <div className="matchup-analysis">
              <div className="win-probability">
                Win Probability: <strong>{matchup.winProbability}%</strong>
              </div>
              <p className="matchup-reasoning">{matchup.reasoning}</p>
            </div>
          </div>
        ))}
      </div>
    )}
    
    <FooterInfo data={data} />
  </div>
);

const PlayerBox = ({ player, isPick }) => (
  <div className={`player-box ${isPick ? 'winner' : ''}`}>
    <h4>{player.name}</h4>
    <div className="player-odds">{Math.round(player.odds)}/1</div>
    <div className="player-stats">
      {['OTT', 'APP', 'ARG', 'Putt'].map(stat => (
        <div key={stat} className="stat-row">
          <span>SG:{stat}</span>
          <span className="stat-value">{player[`sg${stat}`]}</span>
        </div>
      ))}
    </div>
    {isPick && <div className="winner-badge">✓ PICK</div>}
  </div>
);

// ==================== RESULTS VIEW ====================
const ResultsView = ({ data, requestId }) => {
  if (!data.tournaments || data.tournaments.length === 0) {
    return (
      <div className="predictions-container" key={`results-${requestId}`}>
        <div style={{textAlign: 'center', padding: '4rem 2rem'}}>
          <h3>No Predictions Saved Yet</h3>
          <p>Generate some predictions first, and they'll automatically be saved for results tracking!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="predictions-container" key={`results-${requestId}`}>
      <div style={{textAlign: 'center', marginBottom: '2rem'}}>
        <h2>🏆 Prediction Results History</h2>
        <div style={{display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1rem', flexWrap: 'wrap'}}>
          <span style={{background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', padding: '0.5rem 1rem', borderRadius: '20px', fontWeight: 600}}>
            📊 {data.totalPredictions || 0} Total Picks
          </span>
          <span style={{background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', padding: '0.5rem 1rem', borderRadius: '20px', fontWeight: 600}}>
            ✅ {data.completedTournaments || 0} Completed
          </span>
        </div>
      </div>

      <div>
        {data.tournaments.map((tournament, index) => (
          <div key={index} style={{background: 'white', borderRadius: '12px', padding: '2rem', marginBottom: '2rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', border: tournament.status === 'completed' ? '2px solid #4caf50' : '2px solid #ff9800'}}>
            <div style={{borderBottom: '2px solid #f0f0f0', paddingBottom: '1rem', marginBottom: '1.5rem'}}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem'}}>
                <h3 style={{margin: 0}}>{tournament.tournament.name}</h3>
                <span style={{padding: '0.4rem 1rem', borderRadius: '20px', fontSize: '0.85rem', fontWeight: 600, background: tournament.status === 'completed' ? '#e8f5e9' : '#fff3e0', color: tournament.status === 'completed' ? '#2e7d32' : '#e65100'}}>
                  {tournament.status === 'completed' ? '✅ Completed' : '⏳ Pending'}
                </span>
              </div>
              <div style={{display: 'flex', gap: '1.5rem', color: '#666', fontSize: '0.9rem', flexWrap: 'wrap'}}>
                <span>📍 {tournament.tournament.course}</span>
                <span>📅 {tournament.tournament.dates}</span>
                <span>🔮 {new Date(tournament.generatedAt).toLocaleDateString()}</span>
              </div>
            </div>

            {tournament.status === 'completed' && tournament.analysis ? (
              <div>
                <h4>📈 Performance</h4>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '1rem', marginBottom: '1.5rem'}}>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Wins</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.wins}/{tournament.analysis.totalPicks}</div>
                  </div>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Top 5</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.top5s}/{tournament.analysis.totalPicks}</div>
                  </div>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Top 10</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.top10s}/{tournament.analysis.totalPicks}</div>
                  </div>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Made Cut</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.madeCut}/{tournament.analysis.totalPicks}</div>
                  </div>
                </div>
                <div style={{background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', padding: '1.5rem', borderRadius: '8px', color: 'white', textAlign: 'center'}}>
                  <div style={{fontSize: '0.9rem', marginBottom: '0.5rem', opacity: 0.9}}>Total ROI ($100/pick)</div>
                  <div style={{fontSize: '2.5rem', fontWeight: 'bold', color: tournament.analysis.totalROI >= 0 ? '#4caf50' : '#f44336', background: 'white', padding: '0.5rem', borderRadius: '8px'}}>
                    {tournament.analysis.totalROI >= 0 ? '+' : ''}${tournament.analysis.totalROI.toFixed(2)}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <p style={{color: '#666'}}>Waiting for tournament to complete...</p>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem', marginTop: '1rem'}}>
                  {tournament.predictions.map((pick, idx) => (
                    <div key={idx} style={{background: '#f8f9fa', border: '2px solid #ff9800', borderRadius: '8px', padding: '1rem'}}>
                      <h5 style={{margin: '0 0 0.5rem 0'}}>{pick.player}</h5>
                      <div style={{fontSize: '1.3rem', fontWeight: 'bold', color: '#667eea'}}>{Math.round(pick.odds)}/1</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default App;
