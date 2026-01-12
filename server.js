const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", `${__dirname}/views`);
app.use(express.static(`${__dirname}/public`));

const APISPORTS_BASE_URL = "https://v1.basketball.api-sports.io";
const ODDS_BASE_URL = "https://api.the-odds-api.com/v4";

function normalizeTeamName(name) {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/\bthe\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function extractLiveScore(game) {
  const home = game?.scores?.home?.total;
  const away = game?.scores?.away?.total;
  if (isNumber(home) && isNumber(away)) {
    return { home, away, estimated: false };
  }
  return null;
}

function extractPeriodTotals(periods) {
  if (!periods || typeof periods !== "object") return null;
  const totals = { home: 0, away: 0 };
  let hasValue = false;
  Object.values(periods).forEach((period) => {
    if (isNumber(period?.home)) {
      totals.home += period.home;
      hasValue = true;
    }
    if (isNumber(period?.away)) {
      totals.away += period.away;
      hasValue = true;
    }
  });
  return hasValue ? totals : null;
}

function extractStatsTotals(stats) {
  if (!stats || typeof stats !== "object") return null;
  const homeStats = stats?.home;
  const awayStats = stats?.away;
  const totals = { home: null, away: null };

  if (isNumber(homeStats?.points)) totals.home = homeStats.points;
  if (isNumber(awayStats?.points)) totals.away = awayStats.points;

  if (isNumber(totals.home) && isNumber(totals.away)) {
    return { home: totals.home, away: totals.away };
  }

  return null;
}

function estimateScore(game) {
  const periodTotals = extractPeriodTotals(game?.periods);
  if (periodTotals) return { ...periodTotals, estimated: true };

  const statsTotals = extractStatsTotals(game?.statistics);
  if (statsTotals) return { ...statsTotals, estimated: true };

  return null;
}

async function fetchLiveGames() {
  const apiKey = process.env.APISPORTS_KEY;
  if (!apiKey) {
    throw new Error("Missing APISPORTS_KEY environment variable.");
  }

  const url = `${APISPORTS_BASE_URL}/games?league=12&live=all`;
  const response = await fetch(url, {
    headers: {
      "x-apisports-key": apiKey
    }
  });

  if (!response.ok) {
    throw new Error(`API-Sports error: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  return payload?.response || [];
}

async function fetchOdds() {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ODDS_API_KEY environment variable.");
  }

  const url = `${ODDS_BASE_URL}/sports/basketball_nba/odds/?apiKey=${apiKey}&regions=us&markets=h2h&oddsFormat=american`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`The Odds API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function buildOddsMap(oddsGames) {
  const map = new Map();

  oddsGames.forEach((game) => {
    const homeName = normalizeTeamName(game?.home_team);
    const awayName = normalizeTeamName(game?.away_team);
    if (!homeName || !awayName) return;

    const key = `${awayName}__${homeName}`;
    const bookmaker = game?.bookmakers?.[0];
    const market = bookmaker?.markets?.[0];
    const outcomes = market?.outcomes || [];

    const homeOutcome = outcomes.find(
      (outcome) => normalizeTeamName(outcome?.name) === homeName
    );
    const awayOutcome = outcomes.find(
      (outcome) => normalizeTeamName(outcome?.name) === awayName
    );

    map.set(key, {
      homeMl: homeOutcome?.price ?? null,
      awayMl: awayOutcome?.price ?? null
    });
  });

  return map;
}

function mergeBoardData(liveGames, oddsGames) {
  const oddsMap = buildOddsMap(oddsGames);

  return liveGames.map((game) => {
    const homeName = game?.teams?.home?.name || "Home";
    const awayName = game?.teams?.away?.name || "Away";

    const oddsKey = `${normalizeTeamName(awayName)}__${normalizeTeamName(homeName)}`;
    const odds = oddsMap.get(oddsKey) || { homeMl: null, awayMl: null };

    const liveScore = extractLiveScore(game);
    const estimatedScore = liveScore ? null : estimateScore(game);
    const score = liveScore || estimatedScore;

    return {
      id: game?.id || `${awayName}-${homeName}`,
      homeName,
      awayName,
      score: score
        ? {
            home: score.home,
            away: score.away,
            estimated: score.estimated
          }
        : null,
      odds
    };
  });
}

async function getBoardData() {
  const [liveGames, oddsGames] = await Promise.all([
    fetchLiveGames(),
    fetchOdds()
  ]);

  return mergeBoardData(liveGames, oddsGames);
}

app.get("/api/board", async (req, res) => {
  try {
    const board = await getBoardData();
    res.json({ updatedAt: new Date().toISOString(), games: board });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Failed to load board",
      games: []
    });
  }
});

app.get("/", async (req, res) => {
  try {
    const board = await getBoardData();
    res.render("index", {
      updatedAt: new Date(),
      games: board
    });
  } catch (error) {
    res.status(500).render("index", {
      updatedAt: new Date(),
      games: [],
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
