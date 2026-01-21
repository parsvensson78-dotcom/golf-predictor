# 🏌️ Golf AI Predictor

AI-powered PGA Tour and DP World Tour predictions based on course fit analysis and betting value.

## Features

- **Smart Course Fit Analysis**: Uses player stats (SG: Total, OTT, APP, ARG, Putt) to identify players who match the course characteristics
- **Complete Field Analysis**: Analyzes the ENTIRE tournament field (120-156 players), not just favorites - value is often found in overlooked players
- **Value Betting Focus**: Finds players whose stats suggest they're underpriced by bookmakers across all tiers
- **Efficient Token Usage**: ~13,000-16,000 tokens per prediction (~$0.06-0.08) for complete field analysis
- **Dual Tour Support**: PGA Tour and DP World Tour
- **Real-time Data**: Scrapes current tournament info, player stats, and odds
- **Clean UI**: Simple, focused interface showing 3 top picks with concise reasoning

## Architecture

### Data Sources
- **ESPN Golf**: Current tournaments, fields, courses
- **DataGolf**: Player statistics (Strokes Gained metrics)
- **Odds Sites**: Betting odds (OddsAPI or web scraping)
- **OpenWeather**: Basic weather conditions

### Tech Stack
- **Frontend**: React + Vite
- **Backend**: Netlify Functions (Node.js)
- **AI**: Claude Sonnet 4.5 via Anthropic API
- **Hosting**: Netlify

## Setup Instructions

### 1. Prerequisites
- Node.js 18+ installed
- Netlify account (paid subscription for better function limits)
- GitHub account
- Claude Pro API key from Anthropic

### 2. Environment Variables

Create a `.env` file in the root directory:
```bash
# Required
ANTHROPIC_API_KEY=your_claude_api_key_here

# Optional (enhance odds accuracy)
ODDS_API_KEY=your_odds_api_key_here

# Optional (add weather data)
WEATHER_API_KEY=your_openweather_api_key_here
```

### 3. Local Development
```bash
# Install dependencies
npm install

# Install Netlify CLI globally
npm install -g netlify-cli

# Start development server (runs both Vite and Netlify Functions)
netlify dev
```

Visit `http://localhost:8888` to see the app.

### 4. Deploy to Netlify

#### Option A: Via Netlify CLI
```bash
# Login to Netlify
netlify login

# Initialize site
netlify init

# Deploy
netlify deploy --prod
```

#### Option B: Via GitHub Integration
1. Push code to GitHub repository
2. Go to [Netlify Dashboard](https://app.netlify.com)
3. Click "Add new site" → "Import an existing project"
4. Connect to your GitHub repo
5. Netlify will auto-detect settings from `netlify.toml`
6. Add environment variables in Site Settings → Environment Variables
7. Deploy!

### 5. Set Environment Variables on Netlify

In Netlify Dashboard:
1. Go to Site Settings → Environment Variables
2. Add your API keys:
   - `ANTHROPIC_API_KEY`
   - `ODDS_API_KEY` (optional)
   - `WEATHER_API_KEY` (optional)

## Project Structure
```
golf-predictor/
├── netlify/
│   └── functions/
│       ├── get-predictions.js    # Main endpoint (orchestrates everything)
│       ├── fetch-tournament.js   # Scrapes ESPN for tournament info
│       ├── fetch-stats.js        # Gets player stats from DataGolf
│       └── fetch-odds.js         # Fetches betting odds
├── src/
│   ├── App.jsx                   # Main React component
│   ├── App.css                   # Styles
│   └── index.js                  # React entry point
├── index.html
├── vite.config.js
├── netlify.toml
└── package.json
```

## How It Works

1. **User selects tour** (PGA or DP World)
2. **System fetches data**:
   - Current tournament from ESPN (complete field)
   - Stats for ALL players in field from DataGolf
   - Betting odds for entire field
   - Weather conditions
3. **Data goes to Claude AI**:
   - Receives complete field organized by tiers (favorites, mid-tier, longshots)
   - Analyzes stats vs course requirements across all players
   - Identifies undervalued players at any odds level
   - Returns 3 best value picks with reasoning
4. **UI displays results**: Player name, odds, and concise explanation

## Token Efficiency

Average per prediction run (analyzing complete 120-156 player field):
- Input: ~12,000-15,000 tokens (tournament + complete field with stats)
- Output: ~1,000 tokens (3 picks with detailed explanations)
- **Total: ~13,000-16,000 tokens ≈ $0.06-0.08**

Cost breakdown (Claude Sonnet 4.5):
- Input: $3 per million tokens
- Output: $15 per million tokens

**Why analyze the complete field?**
Value picks are often found in mid-tier and longshot players who have excellent course-fit stats but are overlooked by oddsmakers. Limiting to favorites would miss these opportunities.

## Optimization Tips

1. **Caching**: Functions cache data with appropriate TTLs
   - Tournament data: 12 hours
   - Player stats: 24 hours
   - Odds: 4 hours

2. **Complete Field Analysis**: Analyzes all 120-156 players but organizes them efficiently in tiers

3. **Structured Prompts**: Compact data format and requests JSON output to minimize tokens

4. **Single API Call**: One comprehensive Claude call analyzing the entire field

## Troubleshooting

### Functions timing out
- Increase function timeout in `netlify.toml`
- Add more aggressive caching
- Reduce number of players analyzed

### Scraping errors
- ESPN/DataGolf may change HTML structure
- Check console logs for specific errors
- May need to update selectors in scraping functions

### Odds not available
- Functions fall back to estimated odds
- Consider signing up for OddsAPI (has free tier)
- Or implement more robust scraping

## Future Enhancements

- [ ] Historical accuracy tracking
- [ ] Multiple course types (links, parkland, desert)
- [ ] Head-to-head comparisons
- [ ] Recent form weighting
- [ ] Course history stats
- [ ] Email notifications for weekly picks

## API Usage & Costs

With typical usage (checking predictions 2-3x per week per tour):
- **Weekly tokens**: ~80,000-120,000 (complete field analysis)
- **Monthly cost**: ~$3-5 with Claude Sonnet 4.5

The extra cost of analyzing the complete field (~$0.04 more per run) is worthwhile because:
- Value picks often come from overlooked mid-tier players
- One good longshot pick can return 50-100x the API cost
- Complete analysis provides better strategic insight

Netlify Functions (Paid plan):
- 1M function requests/month
- 100 hours function runtime/month
- More than sufficient for this use case

## Contributing

Feel free to fork and improve! Key areas for contribution:
- Better scraping reliability
- Enhanced course-type detection
- Alternative data sources
- UI improvements

## License

MIT

---

Built with ⛳ by Pär
