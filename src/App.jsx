import React, { useState } from 'react';
import './App.css';

function App() {
  const [tour, setTour] = useState('pga');
  const [predictions, setPredictions] = useState(null);
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

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setPredictions(null);
    setError(null);
    setRequestId(requestId + 1);
  };

  const handleGetPredictions = () => {
    fetchPredictions(tour);
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

      <div className="action-section">
        <button 
          className="get-predictions-btn"
          onClick={handleGetPredictions}
          disabled={loading}
        >
          {loading ? 'Analyzing...' : 'Get Predictions'}
        </button>
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
              <span>🌤️ {predictions.weather}</span>
            </div>
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
                    <span className="pick-odds">{Math.round(pick.odds)}/1</span>
                  </div>
                  <h3 className="pick-name">{pick.player}</h3>
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
              <p className="token-usage">
                API tokens: {predictions.tokensUsed.toLocaleString()}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
