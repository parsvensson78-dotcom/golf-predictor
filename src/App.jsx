import React, { useState } from 'react';
import './App.css';

function App() {
  const [tour, setTour] = useState('pga');
  const [activeTab, setActiveTab] = useState('predictions'); // 'predictions', 'avoid', 'news', or 'matchups'
  const [predictions, setPredictions] = useState(null);
  const [avoidPicks, setAvoidPicks] = useState(null);
  const [newsPreview, setNewsPreview] = useState(null);
  const [matchups, setMatchups] = useState(null);
  const [customMatchup, setCustomMatchup] = useState({ playerA: '', playerB: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requestId, setRequestId] = useState(0);

  const fetchPredictions = async (selectedTour) => {
    // Increment request ID to force re-render
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    
    // Clear everything immediately
    setPredictions(null);
    setError(null);
    setLoading(true);
    
    try {
      // Add cache-busting timestamp to URL
      const timestamp = new Date().getTime();
      const response = await fetch(
        `/.netlify/functions/get-predictions?tour=${selectedTour}&_=${timestamp}`,
        {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache'
          }
        }
      );
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch predictions');
      }
      
      const data = await response.json();
      setPredictions(data);
      
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchNewsPreview = async (selectedTour) => {
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    
    setNewsPreview(null);
    setError(null);
    setLoading(true);
    
    try {
      const timestamp = new Date().getTime();
      const response = await fetch(
        `/.netlify/functions/get-tournament-news?tour=${selectedTour}&_=${timestamp}`,
        {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache'
          }
        }
      );
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch news');
      }
      
      const data = await response.json();
      setNewsPreview(data);
      
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchMatchups = async (selectedTour, customPlayers = null) => {
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    
    setMatchups(null);
    setError(null);
    setLoading(true);
    
    try {
      const timestamp = new Date().getTime();
      const response = await fetch(
        `/.netlify/functions/get-matchup-predictions`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          },
          body: JSON.stringify({
            tour: selectedTour,
            customMatchup: customPlayers,
            _: timestamp
          })
        }
      );
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch matchups');
      }
      
      const data = await response.json();
      setMatchups(data);
      
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAvoidPicks = async (selectedTour) => {
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    
    setAvoidPicks(null);
    setError(null);
    setLoading(true);
    
    try {
      const timestamp = new Date().getTime();
      const response = await fetch(
        `/.netlify/functions/get-avoid-picks`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
          },
          body: JSON.stringify({
            tour: selectedTour,
            _: timestamp
          })
        }
      );
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch avoid picks');
      }
      
      const data = await response.json();
      setAvoidPicks(data);
      
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setPredictions(null);
    setAvoidPicks(null);
    setNewsPreview(null);
    setMatchups(null);
    setError(null);
    setRequestId(requestId + 1);
  };

  const handleGetPredictions = () => {
    fetchPredictions(tour);
  };

  const handleGetAvoidPicks = () => {
    fetchAvoidPicks(tour);
  };

  const handleGetNews = () => {
    fetchNewsPreview(tour);
  };

  const handleGetMatchups = () => {
    fetchMatchups(tour);
  };

  const handleCustomMatchup = () => {
    if (customMatchup.playerA && customMatchup.playerB) {
      fetchMatchups(tour, customMatchup);
    } else {
      alert('Please select both players for custom matchup');
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🏌️ Golf AI Predictor</h1>
        <p className="subtitle">Complete field analysis • Course-fit value picks • AI powered</p>
      </header>

      <div className="tour-selector">
        <button 
          className={`tour-btn ${tour === 'pga' ? 'active' : ''}`}
          onClick={() => handleTourChange('pga')}
          disabled={loading}
        >
          PGA Tour
        </button>
        <button 
          className={`tour-btn ${tour === 'dp' ? 'active' : ''}`}
          onClick={() => handleTourChange('dp')}
          disabled={loading}
        >
          DP World Tour
        </button>
      </div>

      <div className="tab-selector">
        <button 
          className={`tab-btn ${activeTab === 'predictions' ? 'active' : ''}`}
          onClick={() => setActiveTab('predictions')}
          disabled={loading}
        >
          📊 Value Predictions
        </button>
        <button 
          className={`tab-btn ${activeTab === 'avoid' ? 'active' : ''}`}
          onClick={() => setActiveTab('avoid')}
          disabled={loading}
        >
          ❌ Avoid Picks
        </button>
        <button 
          className={`tab-btn ${activeTab === 'news' ? 'active' : ''}`}
          onClick={() => setActiveTab('news')}
          disabled={loading}
        >
          📰 News & Preview
        </button>
        <button 
          className={`tab-btn ${activeTab === 'matchups' ? 'active' : ''}`}
          onClick={() => setActiveTab('matchups')}
          disabled={loading}
        >
          🆚 Matchup Predictor
        </button>
      </div>

      <div className="action-section">
        {activeTab === 'predictions' ? (
          <button 
            className="get-predictions-btn"
            onClick={handleGetPredictions}
            disabled={loading}
          >
            {loading ? 'Analyzing...' : 'Get Predictions'}
          </button>
        ) : activeTab === 'avoid' ? (
          <button 
            className="get-predictions-btn"
            onClick={handleGetAvoidPicks}
            disabled={loading}
          >
            {loading ? 'Analyzing...' : 'Get Avoid Picks'}
          </button>
        ) : activeTab === 'news' ? (
          <button 
            className="get-predictions-btn"
            onClick={handleGetNews}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Get News & Preview'}
          </button>
        ) : (
          <button 
            className="get-predictions-btn"
            onClick={handleGetMatchups}
            disabled={loading}
          >
            {loading ? 'Analyzing...' : 'Get Matchup Predictions'}
          </button>
        )}
      </div>

      {loading && (
        <div className="loading" key={`loading-${requestId}`}>
          <div className="spinner"></div>
          <p>Analyzing complete tournament field...</p>
          <p className="loading-subtext">Evaluating 120+ players for value picks</p>
        </div>
      )}

      {error && !loading && (
        <div className="error" key={`error-${requestId}`}>
          <p>❌ {error}</p>
          <button onClick={handleGetPredictions}>Retry</button>
        </div>
      )}

      {predictions && !loading && !error && (
        <div className="predictions-container" key={`predictions-${requestId}-${predictions.generatedAt}`}>
          <div className="tournament-info">
            <h2>{predictions.tournament.name}</h2>
            <div className="tournament-details">
              <span>📍 {predictions.tournament.course}</span>
              <span>📅 {predictions.tournament.dates}</span>
            </div>

            {/* DAILY WEATHER FORECAST */}
            {predictions.dailyForecast && predictions.dailyForecast.length > 0 && (
              <div className="weather-forecast-section">
                <h3>🌤️ Tournament Week Forecast</h3>
                <div className="daily-forecast-grid">
                  {predictions.dailyForecast.map((day, index) => (
                    <div key={index} className="forecast-day-card">
                      <div className="forecast-day-name">{day.day}</div>
                      <div className="forecast-temp">
                        <span className="temp-high">{day.tempHigh}°</span>
                        <span className="temp-divider">/</span>
                        <span className="temp-low">{day.tempLow}°</span>
                      </div>
                      <div className="forecast-condition">{day.condition}</div>
                      <div className="forecast-details">
                        <span className="forecast-wind">
                          💨 {day.windSpeed}mph
                        </span>
                        {day.chanceOfRain > 30 && (
                          <span className="forecast-rain">
                            🌧️ {day.chanceOfRain}%
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ENHANCED COURSE INFORMATION SECTION */}
          {predictions.courseInfo && (
            <div className="course-details-card">
              <div className="course-header-section">
                <h3>⛳ Course Profile: {predictions.courseInfo.name}</h3>
                {predictions.courseInfo.difficulty && (
                  <span className="difficulty-badge">{predictions.courseInfo.difficulty}</span>
                )}
              </div>

              <div className="course-overview">
                <h4>📏 Course Specifications</h4>
                <div className="course-stats-grid">
                  {predictions.courseInfo.yardage && (
                    <div className="course-stat highlight">
                      <span className="stat-label">Total Length</span>
                      <span className="stat-value">{predictions.courseInfo.yardage.toLocaleString()}</span>
                      <span className="stat-unit">yards</span>
                    </div>
                  )}
                  <div className="course-stat">
                    <span className="stat-label">Par</span>
                    <span className="stat-value">{predictions.courseInfo.par}</span>
                    <span className="stat-unit">strokes</span>
                  </div>
                  {predictions.courseInfo.avgScore && (
                    <div className="course-stat">
                      <span className="stat-label">Tour Average</span>
                      <span className="stat-value">{predictions.courseInfo.avgScore}</span>
                      <span className="stat-unit">strokes</span>
                    </div>
                  )}
                  {predictions.courseInfo.avgScore && predictions.courseInfo.par && (
                    <div className="course-stat">
                      <span className="stat-label">Scoring Margin</span>
                      <span className="stat-value">
                        {(predictions.courseInfo.avgScore - predictions.courseInfo.par) > 0 ? '+' : ''}
                        {(predictions.courseInfo.avgScore - predictions.courseInfo.par).toFixed(1)}
                      </span>
                      <span className="stat-unit">vs par</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="course-characteristics-detailed">
                <h4>🏌️ Course Characteristics</h4>
                <div className="characteristics-grid">
                  <div className="characteristic-card">
                    <div className="char-icon">🎯</div>
                    <div className="char-content">
                      <strong>Fairways</strong>
                      <p>{predictions.courseInfo.width}</p>
                    </div>
                  </div>
                  <div className="characteristic-card">
                    <div className="char-icon">🟢</div>
                    <div className="char-content">
                      <strong>Greens</strong>
                      <p>{predictions.courseInfo.greens}</p>
                    </div>
                  </div>
                  <div className="characteristic-card">
                    <div className="char-icon">🌿</div>
                    <div className="char-content">
                      <strong>Rough</strong>
                      <p>{predictions.courseInfo.rough}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* COURSE NOTES SECTION */}
              {predictions.courseAnalysis && predictions.courseAnalysis.notes && (
                <div className="course-notes-section">
                  <h4>📝 Course Setup & Betting Insights</h4>
                  <div className="course-notes-content">
                    <p>{predictions.courseAnalysis.notes}</p>
                  </div>
                </div>
              )}

              {predictions.courseInfo.keyFeatures && predictions.courseInfo.keyFeatures.length > 0 && (
                <div className="key-features-detailed">
                  <h4>⭐ Signature Course Features</h4>
                  <div className="features-grid">
                    {predictions.courseInfo.keyFeatures.map((feature, idx) => (
                      <div key={idx} className="feature-item">
                        <span className="feature-bullet">⛳</span>
                        <span className="feature-text">{feature}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {predictions.courseInfo.rewards && predictions.courseInfo.rewards.length > 0 && (
                <div className="rewards-skills-detailed">
                  <h4>💪 Critical Skills for Success</h4>
                  <p className="skills-intro">This course rewards players who excel in:</p>
                  <div className="skills-tags">
                    {predictions.courseInfo.rewards.map((skill, idx) => (
                      <span key={idx} className="skill-tag-enhanced">
                        <span className="skill-number">{idx + 1}</span>
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* COURSE ANALYSIS SECTION */}
          {predictions.courseAnalysis && (
            <div className="course-analysis">
              <h3>📊 Course Analysis</h3>
              <div className="analysis-item">
                <strong>Course Type:</strong> {predictions.courseAnalysis.type}
              </div>
              <div className="analysis-item">
                <strong>Weather Impact:</strong> {predictions.courseAnalysis.weatherImpact}
              </div>
              {predictions.courseAnalysis.keyFactors && predictions.courseAnalysis.keyFactors.length > 0 && (
                <div className="analysis-item">
                  <strong>Key Success Factors:</strong>
                  <ul className="factors-list">
                    {predictions.courseAnalysis.keyFactors.map((factor, idx) => (
                      <li key={idx}>{factor}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* VALUE PICKS SECTION */}
          <div className="picks-section">
            <h3>💎 Value Picks</h3>
            <div className="picks-grid">
              {predictions.predictions && predictions.predictions.map((pick, index) => (
                <div key={`pick-${requestId}-${index}`} className="pick-card">
                  <div className="pick-header">
                    <span className="pick-number">#{index + 1}</span>
                    <div className="odds-container">
                      {Math.round(pick.odds)}/1
                    </div>
                  </div>
                  <h3 className="pick-name">{pick.player}</h3>
                  
                  {/* ODDS BREAKDOWN SECTION */}
                  <div className="odds-breakdown-section">
                    <div className="odds-breakdown-grid">
                      <div className="odds-item best">
                        <div className="odds-label">Best Odds</div>
                        <div className="odds-value">{pick.americanMinOdds || 'N/A'}</div>
                        {pick.bestBookmaker && (
                          <div className="odds-bookmaker">{pick.bestBookmaker}</div>
                        )}
                      </div>
                      <div className="odds-item average">
                        <div className="odds-label">Average</div>
                        <div className="odds-value">{pick.americanOdds || 'N/A'}</div>
                        <div className="odds-bookmaker">{pick.bookmakerCount || 0} books</div>
                      </div>
                      <div className="odds-item worst">
                        <div className="odds-label">Worst Odds</div>
                        <div className="odds-value">{pick.americanMaxOdds || 'N/A'}</div>
                        {pick.worstBookmaker && (
                          <div className="odds-bookmaker">{pick.worstBookmaker}</div>
                        )}
                      </div>
                    </div>
                    <div className="odds-tip">
                      💡 Shop around - odds vary between bookmakers
                    </div>
                  </div>

                  <p className="pick-reasoning">{pick.reasoning}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="footer-info">
            <p className="generated-time">
              Generated: {new Date(predictions.generatedAt).toLocaleString()}
            </p>
            {predictions.tokensUsed && (
              <div className="api-usage-info">
                <div className="token-info">
                  <span className="token-label">API tokens:</span>
                  <span className="token-value">{predictions.tokensUsed.toLocaleString()}</span>
                  {predictions.tokenBreakdown && (
                    <span className="token-breakdown">
                      (↓{predictions.tokenBreakdown.input.toLocaleString()} 
                      ↑{predictions.tokenBreakdown.output.toLocaleString()})
                    </span>
                  )}
                </div>
                {predictions.estimatedCost && (
                  <div className="cost-info">
                    <span className="cost-label">Estimated cost:</span>
                    <span className="cost-value">{predictions.estimatedCost.formatted}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* AVOID PICKS TAB */}
      {avoidPicks && !loading && !error && activeTab === 'avoid' && (
        <div className="avoid-picks-container" key={`avoid-${requestId}-${avoidPicks.generatedAt}`}>
          <div className="tournament-info">
            <h2>{avoidPicks.tournament.name}</h2>
            <div className="tournament-details">
              <span>📍 {avoidPicks.tournament.course}</span>
              <span>📅 {avoidPicks.tournament.dates}</span>
            </div>
          </div>

          <div className="avoid-section">
            <h3>❌ Players to Avoid (Poor Course Fit)</h3>
            <p className="avoid-subtitle">{avoidPicks.reasoning}</p>
            <div className="avoid-grid">
              {avoidPicks.avoidPicks && avoidPicks.avoidPicks.map((avoid, index) => (
                <div key={`avoid-${requestId}-${index}`} className="avoid-card">
                  <div className="avoid-header">
                    <span className="avoid-icon">⚠️</span>
                    <span className="avoid-odds">{Math.round(avoid.odds)}/1</span>
                  </div>
                  <h4 className="avoid-name">{avoid.player}</h4>
                  <p className="avoid-reasoning">{avoid.reasoning}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="footer-info">
            <p className="generated-time">
              Generated: {new Date(avoidPicks.generatedAt).toLocaleString()}
            </p>
            {avoidPicks.tokensUsed && (
              <div className="api-usage-info">
                <div className="token-info">
                  <span className="token-label">API tokens:</span>
                  <span className="token-value">{avoidPicks.tokensUsed.toLocaleString()}</span>
                  {avoidPicks.tokenBreakdown && (
                    <span className="token-breakdown">
                      (↓{avoidPicks.tokenBreakdown.input.toLocaleString()} 
                      ↑{avoidPicks.tokenBreakdown.output.toLocaleString()})
                    </span>
                  )}
                </div>
                {avoidPicks.estimatedCost && (
                  <div className="cost-info">
                    <span className="cost-label">Estimated cost:</span>
                    <span className="cost-value">{avoidPicks.estimatedCost.formatted}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* NEWS & PREVIEW TAB */}
      {newsPreview && !loading && !error && activeTab === 'news' && (
        <div className="news-preview-container" key={`news-${requestId}-${newsPreview.generatedAt}`}>
          <div className="tournament-info">
            <h2>{newsPreview.tournament.name}</h2>
            <div className="tournament-details">
              <span>📍 {newsPreview.tournament.course}</span>
              <span>📅 {newsPreview.tournament.dates}</span>
            </div>
          </div>

          {/* AI PREVIEW SECTION */}
          {newsPreview.preview && (
            <div className="ai-preview-section">
              <h3>🤖 AI Tournament Preview</h3>
              
              {newsPreview.preview.overview && (
                <div className="preview-overview">
                  <p>{newsPreview.preview.overview}</p>
                </div>
              )}

              {newsPreview.preview.storylines && newsPreview.preview.storylines.length > 0 && (
                <div className="storylines-section">
                  <h4>📖 Key Storylines</h4>
                  <div className="storylines-grid">
                    {newsPreview.preview.storylines.map((storyline, index) => (
                      <div key={index} className="storyline-card">
                        <span className="storyline-number">{index + 1}</span>
                        <p className="storyline-text">{storyline}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {newsPreview.preview.playersToWatch && newsPreview.preview.playersToWatch.length > 0 && (
                <div className="players-watch-section">
                  <h4>👀 Players to Watch</h4>
                  <div className="players-grid">
                    {newsPreview.preview.playersToWatch.map((player, index) => (
                      <div key={index} className="player-watch-card">
                        <h5>{player.name}</h5>
                        <p>{player.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {newsPreview.preview.bettingAngles && newsPreview.preview.bettingAngles.length > 0 && (
                <div className="betting-angles-section">
                  <h4>💰 Betting Angles</h4>
                  <div className="betting-angles-list">
                    {newsPreview.preview.bettingAngles.map((angle, index) => (
                      <div key={index} className="betting-angle-item">
                        <span className="angle-bullet">💡</span>
                        <p>{angle}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {newsPreview.preview.weatherImpact && (
                <div className="weather-impact-section">
                  <h4>🌤️ Weather Impact</h4>
                  <p>{newsPreview.preview.weatherImpact}</p>
                </div>
              )}
            </div>
          )}

          {/* NEWS ARTICLES SECTION */}
          {newsPreview.news && newsPreview.news.length > 0 && (
            <div className="news-articles-section">
              <h3>📰 Latest Golf News</h3>
              <div className="news-grid">
                {newsPreview.news.map((article, index) => (
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

          <div className="footer-info">
            <p className="generated-time">
              Generated: {new Date(newsPreview.generatedAt).toLocaleString()}
            </p>
            {newsPreview.tokensUsed && (
              <div className="api-usage-info">
                <div className="token-info">
                  <span className="token-label">API tokens:</span>
                  <span className="token-value">{newsPreview.tokensUsed.toLocaleString()}</span>
                  {newsPreview.tokenBreakdown && (
                    <span className="token-breakdown">
                      (↓{newsPreview.tokenBreakdown.input.toLocaleString()} 
                      ↑{newsPreview.tokenBreakdown.output.toLocaleString()})
                    </span>
                  )}
                </div>
                {newsPreview.estimatedCost && (
                  <div className="cost-info">
                    <span className="cost-label">Estimated cost:</span>
                    <span className="cost-value">{newsPreview.estimatedCost.formatted}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* MATCHUP PREDICTOR TAB */}
      {matchups && !loading && !error && activeTab === 'matchups' && (
        <div className="matchup-container" key={`matchup-${requestId}-${matchups.generatedAt}`}>
          <div className="tournament-info">
            <h2>{matchups.tournament.name}</h2>
            <div className="tournament-details">
              <span>📍 {matchups.tournament.course}</span>
              <span>📅 {matchups.tournament.dates}</span>
            </div>
          </div>

          {/* SUGGESTED MATCHUPS */}
          {matchups.suggestedMatchups && matchups.suggestedMatchups.length > 0 && (
            <div className="suggested-matchups-section">
              <h3>🆚 AI-Suggested Matchups</h3>
              <p className="matchup-subtitle">Head-to-head predictions based on stats and course fit</p>
              
              {matchups.suggestedMatchups.map((matchup, index) => (
                <div key={index} className="matchup-card">
                  <div className="matchup-header">
                    <span className="matchup-number">Matchup #{index + 1}</span>
                    <span className={`confidence-badge confidence-${matchup.confidence.toLowerCase().replace('-', '')}`}>
                      {matchup.confidence}
                    </span>
                  </div>

                  <div className="matchup-players">
                    <div className={`player-box ${matchup.pick === matchup.playerA.name ? 'winner' : ''}`}>
                      <h4>{matchup.playerA.name}</h4>
                      <div className="player-odds">{Math.round(matchup.playerA.odds)}/1</div>
                      <div className="player-stats">
                        <div className="stat-row">
                          <span>SG:OTT</span>
                          <span className="stat-value">{matchup.playerA.sgOTT}</span>
                        </div>
                        <div className="stat-row">
                          <span>SG:APP</span>
                          <span className="stat-value">{matchup.playerA.sgAPP}</span>
                        </div>
                        <div className="stat-row">
                          <span>SG:ARG</span>
                          <span className="stat-value">{matchup.playerA.sgARG}</span>
                        </div>
                        <div className="stat-row">
                          <span>SG:Putt</span>
                          <span className="stat-value">{matchup.playerA.sgPutt}</span>
                        </div>
                      </div>
                      {matchup.pick === matchup.playerA.name && (
                        <div className="winner-badge">✓ PICK</div>
                      )}
                    </div>

                    <div className="vs-divider">VS</div>

                    <div className={`player-box ${matchup.pick === matchup.playerB.name ? 'winner' : ''}`}>
                      <h4>{matchup.playerB.name}</h4>
                      <div className="player-odds">{Math.round(matchup.playerB.odds)}/1</div>
                      <div className="player-stats">
                        <div className="stat-row">
                          <span>SG:OTT</span>
                          <span className="stat-value">{matchup.playerB.sgOTT}</span>
                        </div>
                        <div className="stat-row">
                          <span>SG:APP</span>
                          <span className="stat-value">{matchup.playerB.sgAPP}</span>
                        </div>
                        <div className="stat-row">
                          <span>SG:ARG</span>
                          <span className="stat-value">{matchup.playerB.sgARG}</span>
                        </div>
                        <div className="stat-row">
                          <span>SG:Putt</span>
                          <span className="stat-value">{matchup.playerB.sgPutt}</span>
                        </div>
                      </div>
                      {matchup.pick === matchup.playerB.name && (
                        <div className="winner-badge">✓ PICK</div>
                      )}
                    </div>
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

          <div className="footer-info">
            <p className="generated-time">
              Generated: {new Date(matchups.generatedAt).toLocaleString()}
            </p>
            {matchups.tokensUsed && (
              <div className="api-usage-info">
                <div className="token-info">
                  <span className="token-label">API tokens:</span>
                  <span className="token-value">{matchups.tokensUsed.toLocaleString()}</span>
                  {matchups.tokenBreakdown && (
                    <span className="token-breakdown">
                      (↓{matchups.tokenBreakdown.input.toLocaleString()} 
                      ↑{matchups.tokenBreakdown.output.toLocaleString()})
                    </span>
                  )}
                </div>
                {matchups.estimatedCost && (
                  <div className="cost-info">
                    <span className="cost-label">Estimated cost:</span>
                    <span className="cost-value">{matchups.estimatedCost.formatted}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
