import React from 'react';

/**
 * Enhanced Player Card Component
 * Shows average odds, best/worst odds, and bookmaker count
 */
const PlayerCardWithOddsRange = ({ player, reasoning }) => {
  // Convert decimal odds to fractional for display
  const toFractional = (decimal) => {
    if (!decimal) return 'N/A';
    const numerator = Math.round((decimal - 1) * 1);
    return `${numerator}/1`;
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-4 border border-gray-200 hover:shadow-lg transition-shadow">
      {/* Player Name and Rank */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xl font-bold text-gray-900">{player.name}</h3>
        {player.rank && (
          <span className="text-sm text-gray-500 font-medium">
            World Rank: #{player.rank}
          </span>
        )}
      </div>

      {/* Odds Display - Prominent Section */}
      <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-4 mb-4">
        <div className="grid grid-cols-3 gap-4">
          {/* Best Odds */}
          <div className="text-center">
            <div className="text-xs text-gray-600 mb-1 font-medium">BEST ODDS</div>
            <div className="text-2xl font-bold text-green-600">
              {toFractional(player.minOdds)}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {player.minOdds?.toFixed(1)} decimal
            </div>
          </div>

          {/* Average Odds */}
          <div className="text-center border-x border-blue-200">
            <div className="text-xs text-gray-600 mb-1 font-medium">AVERAGE</div>
            <div className="text-2xl font-bold text-blue-600">
              {toFractional(player.odds)}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {player.odds?.toFixed(1)} decimal
            </div>
          </div>

          {/* Worst Odds */}
          <div className="text-center">
            <div className="text-xs text-gray-600 mb-1 font-medium">WORST ODDS</div>
            <div className="text-2xl font-bold text-red-600">
              {toFractional(player.maxOdds)}
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {player.maxOdds?.toFixed(1)} decimal
            </div>
          </div>
        </div>

        {/* Bookmaker Count */}
        <div className="text-center mt-3 pt-3 border-t border-blue-200">
          <span className="text-xs text-gray-600">
            📊 Averaged across <span className="font-bold text-blue-700">{player.bookmakerCount}</span> sportsbooks
          </span>
        </div>
      </div>

      {/* Stats Section */}
      <div className="grid grid-cols-5 gap-2 mb-4 text-center">
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">Total</div>
          <div className="font-bold text-gray-900">{player.sgTotal}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">OTT</div>
          <div className="font-bold text-gray-900">{player.sgOTT}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">APP</div>
          <div className="font-bold text-gray-900">{player.sgAPP}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">ARG</div>
          <div className="font-bold text-gray-900">{player.sgARG}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">Putt</div>
          <div className="font-bold text-gray-900">{player.sgPutt}</div>
        </div>
      </div>

      {/* Reasoning */}
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
        <p className="text-sm text-gray-700 leading-relaxed">{reasoning}</p>
      </div>

      {/* Value Indicator */}
      {player.minOdds && player.maxOdds && (
        <div className="mt-3 text-center">
          <span className="inline-block bg-green-100 text-green-800 text-xs px-3 py-1 rounded-full font-medium">
            💰 Shop for best value - up to {((player.minOdds / player.maxOdds - 1) * 100).toFixed(0)}% better odds available
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Compact Odds Display (for lists/tables)
 */
const CompactOddsDisplay = ({ player }) => {
  const toFractional = (decimal) => {
    if (!decimal) return 'N/A';
    const numerator = Math.round((decimal - 1) * 1);
    return `${numerator}/1`;
  };

  return (
    <div className="inline-flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
      <div className="text-center">
        <div className="text-xs text-green-600 font-medium">Best</div>
        <div className="text-sm font-bold">{toFractional(player.minOdds)}</div>
      </div>
      <div className="text-gray-300">|</div>
      <div className="text-center">
        <div className="text-xs text-blue-600 font-medium">Avg</div>
        <div className="text-sm font-bold">{toFractional(player.odds)}</div>
      </div>
      <div className="text-gray-300">|</div>
      <div className="text-center">
        <div className="text-xs text-red-600 font-medium">Worst</div>
        <div className="text-sm font-bold">{toFractional(player.maxOdds)}</div>
      </div>
    </div>
  );
};

/**
 * Odds Comparison Tooltip Component
 */
const OddsTooltip = ({ player }) => {
  const potentialGain = player.minOdds && player.maxOdds 
    ? ((player.minOdds / player.maxOdds - 1) * 100).toFixed(1)
    : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-4 w-64">
      <h4 className="font-bold text-gray-900 mb-2">Odds Breakdown</h4>
      
      <div className="space-y-2">
        <div className="flex justify-between">
          <span className="text-sm text-gray-600">Best Available:</span>
          <span className="font-bold text-green-600">{player.minOdds?.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-600">Average:</span>
          <span className="font-bold text-blue-600">{player.odds?.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-600">Worst:</span>
          <span className="font-bold text-red-600">{player.maxOdds?.toFixed(1)}</span>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-gray-200">
        <div className="text-xs text-gray-500 mb-1">
          Based on {player.bookmakerCount} bookmakers
        </div>
        {potentialGain > 0 && (
          <div className="text-xs font-medium text-green-600">
            ✨ Shopping can improve returns by {potentialGain}%
          </div>
        )}
      </div>

      <div className="mt-3 text-xs text-gray-400">
        Data from: DraftKings, FanDuel, BetMGM, Bet365, Pinnacle, and more
      </div>
    </div>
  );
};

/**
 * Example Usage in Your App
 */
const PredictionsPage = ({ predictions }) => {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Value Picks</h1>
      
      {predictions.map((pick, index) => (
        <PlayerCardWithOddsRange 
          key={index}
          player={pick.player}
          reasoning={pick.reasoning}
        />
      ))}
    </div>
  );
};

export { 
  PlayerCardWithOddsRange, 
  CompactOddsDisplay, 
  OddsTooltip,
  PredictionsPage 
};
