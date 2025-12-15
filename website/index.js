/**
 * API main code
 */

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const projects = require("./projects");
const CONFFILE = require("../config.json");
const PCKGE = require("../package.json");
const {
  foldProjects,
  queryParams,
  getMapStyle,
  getMapStatsStyle,
  getBadgesDetails,
  getOsmToUrlMappings,
  getProjectDays,
} = require("./utils");
const { Pool } = require("pg");
const { I18n } = require("i18n");

const CONFIG = Object.assign(CONFFILE, { package_version: PCKGE.version });

/*
 * Connect to database
 */
const pool = new Pool({
  connectionString: `${process.env.DB_URL}`,
});

/*
 * Internationalization
 */

const i18n = new I18n({
  locales: ["fr", "en"],
  directory: path.join(__dirname, "locales"),
  autoReload: true,
  defaultLocale: "fr",
  retryInDefaultLocale: true,
});

/*
 * Init API
 */

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.options("*", cors());
app.use(compression());
app.use(i18n.init);
app.use(function (req, res, next) {
  res.locals.__ = res.__ = function () {
    return i18n.__.apply(req, arguments);
  };
  next();
});

app.set("view engine", "pug");
app.set("views", __dirname + "/templates");

// Index
app.get("/", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).render("pages/maintenance");
  }

  const p = foldProjects(projects);
  const nbProjects =
    (p.current ? p.current.length : 0) +
    (p.next ? p.next.length : 0) +
    (p.past ? p.past.length : 0);

  // One single project
  if (nbProjects === 1) {
    // One currently active project
    if (p.current && p.current.length === 1) {
      res.redirect(`/projects/${p.current.pop().id}`);
    }
    // One next project
    else if (p.next && p.next.length > 0) {
      res.redirect(`/projects/${p.next.pop().id}`);
    }
    // One last project
    else if (p.past && p.past.length > 0) {
      res.redirect(`/projects/${p.past.pop().id}`);
    }
  }
  // Multiple projects
  else if (nbProjects > 1) {
    // Don't fetch stats during initial render - let frontend fetch them asynchronously
    // This prevents blocking the page load
    const currentProjects = p.current || [];
    const otherProjects = p.past || [];

    res.render(
      "pages/multi_projects",
      Object.assign({
        CONFIG,
        currentProjects: currentProjects.map((proj) => ({
          ...proj,
          stats: { last30Days: null }, // Placeholder, will be filled by frontend
        })),
        otherProjects: otherProjects.reverse().map((proj) => ({
          ...proj,
          stats: { last30Days: null }, // Placeholder, will be filled by frontend
        })),
        // Ne pas passer icon pour la page d'accueil (multi_projects)
      }),
    );
  }
  // No projects at all
  else {
    res.redirect("/error/500");
  }
});

// API: All projects progress chart
app.get("/api/all-projects-progress", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const allProjects = Object.values(projects);
  
  Promise.all(
    allProjects.map((proj) => {
      return pool
        .query(
          `
          SELECT ts, amount
          FROM pdm_feature_counts
          WHERE project = $1
          ORDER BY ts ASC
        `,
          [proj.id],
        )
        .then((results) => {
          return {
            id: proj.id,
            title: proj.title,
            icon: proj.icon,
            data: results.rows.map((r) => ({
              t: r.ts,
              y: parseInt(r.amount) || 0,
            })),
          };
        })
        .catch(() => {
          return {
            id: proj.id,
            title: proj.title,
            icon: proj.icon,
            data: [],
          };
        });
    }),
  )
    .then((results) => {
      res.json({
        projects: results.filter((r) => r.data.length > 0),
      });
    })
    .catch((err) => {
      console.error("Error fetching all projects progress:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API: Cumulative progress of all projects
app.get("/api/all-projects-cumulative", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const allProjects = Object.values(projects);
  
  Promise.all(
    allProjects.map((proj) => {
      return pool
        .query(
          `
          SELECT ts, amount
          FROM pdm_feature_counts
          WHERE project = $1
          ORDER BY ts ASC
        `,
          [proj.id],
        )
        .then((results) => {
          return results.rows.map((r) => ({
            t: r.ts,
            y: parseInt(r.amount) || 0,
          }));
        })
        .catch(() => {
          return [];
        });
    }),
  )
    .then((allData) => {
      // Merge all data points by timestamp and sum amounts
      const dataMap = new Map();
      
      allData.forEach((projectData) => {
        projectData.forEach((point) => {
          const timestamp = new Date(point.t).toISOString();
          const existing = dataMap.get(timestamp) || 0;
          dataMap.set(timestamp, existing + point.y);
        });
      });
      
      // Convert to array and sort by timestamp
      const cumulativeData = Array.from(dataMap.entries())
        .map(([t, y]) => ({ t, y }))
        .sort((a, b) => new Date(a.t) - new Date(b.t));
      
      // Calculate cumulative sum
      let cumulative = 0;
      const result = cumulativeData.map((point) => {
        cumulative += point.y;
        return {
          t: point.t,
          y: cumulative,
        };
      });
      
      res.json({
        data: result,
      });
    })
    .catch((err) => {
      console.error("Error fetching cumulative progress:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API: Active users over time
app.get("/api/active-users", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  // Get unique users per day from pdm_user_contribs
  pool
    .query(
      `
      SELECT 
        DATE(ts) as date,
        COUNT(DISTINCT userid) as user_count
      FROM pdm_user_contribs
      WHERE ts >= NOW() - INTERVAL '2 years'
      GROUP BY DATE(ts)
      ORDER BY DATE(ts) ASC
    `,
    )
    .then((results) => {
      const data = results.rows.map((r) => ({
        t: r.date,
        y: parseInt(r.user_count) || 0,
      }));
      
      res.json({
        data: data,
      });
    })
    .catch((err) => {
      console.error("Error fetching active users:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API: Cumulative remaining objects to integrate
app.get("/api/all-projects-remaining", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const allProjects = Object.values(projects);
  
  Promise.all(
    allProjects.map((proj) => {
      // Get project target/expected count
      const totalToIntegrate =
        typeof proj.statistics?.total_expected === "number"
          ? proj.statistics.total_expected
          : typeof proj.statistics?.to_integrate === "number"
            ? proj.statistics.to_integrate
            : typeof proj.statistics?.target === "number"
              ? proj.statistics.target
              : null;

      if (totalToIntegrate == null) {
        return Promise.resolve({
          id: proj.id,
          name: proj.title,
          data: [],
          cumulative: [],
        });
      }

      return pool
        .query(
          `
          SELECT ts, amount
          FROM pdm_feature_counts
          WHERE project = $1
          ORDER BY ts ASC
        `,
          [proj.id],
        )
        .then((results) => {
          const chartData = results.rows.map((r) => ({
            t: r.ts,
            y: parseInt(r.amount) || 0,
          }));

          // Calculate remaining over time
          // If no data exists yet, we could initialize with the total, but for now we'll return empty
          // The graph will show data once statistics are calculated
          const remainingData = chartData.length > 0
            ? chartData.map((point) => ({
                t: point.t,
                y: Math.max(0, totalToIntegrate - point.y),
              }))
            : [];

          return {
            id: proj.id,
            name: proj.title,
            data: remainingData,
            cumulative: remainingData, // Will be calculated below
          };
        })
        .catch(() => {
          return {
            id: proj.id,
            name: proj.title,
            data: [],
            cumulative: [],
          };
        });
    }),
  )
    .then((allData) => {
      // Check if any project has an objective defined
      const projectsWithObjectives = allData.filter((proj) => proj.data.length > 0 || proj.cumulative.length > 0);
      const hasAnyObjective = allProjects.some((proj) => {
        return typeof proj.statistics?.total_expected === "number" ||
               typeof proj.statistics?.to_integrate === "number" ||
               typeof proj.statistics?.target === "number";
      });
      
      // Merge all remaining data points by timestamp and sum remaining amounts
      const dataMap = new Map();
      
      allData.forEach((projectData) => {
        projectData.data.forEach((point) => {
          const timestamp = new Date(point.t).toISOString();
          const existing = dataMap.get(timestamp) || 0;
          dataMap.set(timestamp, existing + point.y);
        });
      });
      
      // Convert to array and sort by timestamp
      const cumulativeData = Array.from(dataMap.entries())
        .map(([t, y]) => ({ t, y }))
        .sort((a, b) => new Date(a.t) - new Date(b.t));
      
      // Return both individual project data and cumulative
      // Include metadata about whether objectives exist
      res.json({
        projects: allData.map((proj) => ({
          id: proj.id,
          name: proj.name,
          data: proj.data,
        })),
        cumulative: cumulativeData.length > 0 ? cumulativeData : [],
        hasObjectives: hasAnyObjective,
        hasData: cumulativeData.length > 0,
      });
    })
    .catch((err) => {
      console.error("Error fetching cumulative remaining:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API: Podiums (contributions and quality)
app.get("/api/podiums", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const allProjects = Object.values(projects);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  Promise.all([
    // Contributions podium (last 30 days)
    Promise.all(
      allProjects.map((proj) => {
        return pool
          .query(
            `
            WITH current_count AS (
              SELECT amount, ts
              FROM pdm_feature_counts
              WHERE project = $1
              ORDER BY ts DESC
              LIMIT 1
            ),
            count_30_days_ago AS (
              SELECT amount, ts
              FROM pdm_feature_counts
              WHERE project = $1
                AND ts <= (SELECT ts - INTERVAL '30 days' FROM current_count)
              ORDER BY ts DESC
              LIMIT 1
            )
            SELECT 
              COALESCE((SELECT amount FROM current_count), 0) AS current_amount,
              COALESCE((SELECT amount FROM count_30_days_ago), 0) AS past_amount
          `,
            [proj.id],
          )
          .then((results) => {
            if (results.rows.length === 0) {
              return null;
            }
            const row = results.rows[0];
            const currentAmount = parseInt(row.current_amount) || 0;
            const pastAmount = parseInt(row.past_amount) || 0;
            const added = Math.max(0, currentAmount - pastAmount);

            return added > 0
              ? {
                  id: proj.id,
                  title: proj.title,
                  icon: proj.icon,
                  added: added,
                }
              : null;
          })
          .catch(() => null);
      }),
    ).then((results) =>
      results
        .filter((r) => r !== null)
        .sort((a, b) => b.added - a.added)
        .slice(0, 3),
    ),

    // Quality podium (last 30 days - average completion increase)
    Promise.all(
      allProjects
        .filter((proj) => proj.quality && proj.quality.required_tags)
        .map((proj) => {
          return pool
            .query(
              `
              WITH current_quality AS (
                SELECT avg_completion, ts
                FROM pdm_quality_stats
                WHERE project = $1
                ORDER BY ts DESC
                LIMIT 1
              ),
              quality_30_days_ago AS (
                SELECT avg_completion, ts
                FROM pdm_quality_stats
                WHERE project = $1
                  AND ts <= (SELECT ts - INTERVAL '30 days' FROM current_quality)
                ORDER BY ts DESC
                LIMIT 1
              )
              SELECT 
                COALESCE((SELECT avg_completion FROM current_quality), 0) AS current_avg,
                COALESCE((SELECT avg_completion FROM quality_30_days_ago), 0) AS past_avg
            `,
              [proj.id],
            )
            .then((results) => {
              if (results.rows.length === 0) {
                return null;
              }
              const row = results.rows[0];
              const currentAvg = parseFloat(row.current_avg) || 0;
              const pastAvg = parseFloat(row.past_avg) || 0;
              const increase = currentAvg - pastAvg;

              return increase > 0
                ? {
                    id: proj.id,
                    title: proj.title,
                    icon: proj.icon,
                    increase: parseFloat(increase.toFixed(2)),
                    current: parseFloat(currentAvg.toFixed(2)),
                    past: parseFloat(pastAvg.toFixed(2)),
                  }
                : null;
            })
            .catch(() => null);
        }),
    ).then((results) =>
      results
        .filter((r) => r !== null)
        .sort((a, b) => b.increase - a.increase)
        .slice(0, 3),
    ),
  ])
    .then(([contributionsPodium, qualityPodium]) => {
      res.json({
        contributions: contributionsPodium,
        quality: qualityPodium,
      });
    })
    .catch((err) => {
      console.error("Error fetching podiums:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// About
app.get("/about", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).render("pages/maintenance");
  }

  res.render("pages/about", Object.assign({ CONFIG }));
});

// HTTP errors
app.get("/error/:code", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  const httpcode =
    req.params.code && !isNaN(req.params.code) ? parseInt(req.params.code) : 400;
  res.status(httpcode).render("pages/error", { CONFIG, httpcode });
});

// Project page
app.get("/projects/:id", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.redirect("/error/404");
  }

  const p = projects[req.params.id];
  const all = foldProjects(projects);
  const toDisplay = all.past
    .reverse()
    .concat(all.current.filter((p) => p.id !== req.params.id));
  const isActive =
    all.current.length > 0 &&
    all.current.find((p) => p.id === req.params.id) !== undefined;
  const isNext =
    all.next && all.next.find((p) => p.id === req.params.id) !== undefined;
  const isRecentPast =
    all.past &&
    all.past.length > 0 &&
    all.past.find(
      (p) =>
        p.id === req.params.id &&
        new Date(p.end_date + "T23:59:59Z").getTime() >=
          Date.now() - 30 * 24 * 60 * 60 * 1000,
    ) !== undefined;
  res.render(
    "pages/project",
    Object.assign(
      {
        CONFIG,
        isActive,
        isNext,
        isRecentPast,
        projects: all,
        projectsToDisplay: toDisplay,
        days: getProjectDays(p),
      },
      p,
    ),
  );
});

// Project map editor
app.get("/projects/:id/map", async (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.redirect("/error/404");
  }

  const p = projects[req.params.id];
  const all = foldProjects(projects);
  const isActive =
    all.current.length > 0 &&
    all.current.find((p) => p.id === req.params.id) !== undefined;
  const mapstyle = await getMapStyle(p);
  res.render(
    "pages/map",
    Object.assign(
      { CONFIG, isActive, tagToUrl: getOsmToUrlMappings() },
      p,
      mapstyle,
    ),
  );
});

// Project notes list
app.get("/projects/:id/issues", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.redirect("/error/404");
  }

  const p = projects[req.params.id];
  const all = foldProjects(projects);
  const isActive =
    all.current.length > 0 &&
    all.current.find((p) => p.id === req.params.id) !== undefined;
  res.render("pages/issues", Object.assign({ CONFIG, isActive }, p));
});

// All projects statistics (optimized endpoint for homepage)
app.get("/projects/all/stats", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const allProjects = Object.values(projects);
  const osmUserAuthentified =
    typeof req.query.osm_user === "string" &&
    req.query.osm_user.trim().length > 0;

  // Fetch stats for all projects in parallel
  Promise.all(
    allProjects.map((proj) => {
      // Get basic counts (30 days, 180 days)
      return pool
        .query(
          `
          WITH current_count AS (
            SELECT amount, ts
            FROM pdm_feature_counts
            WHERE project = $1
            ORDER BY ts DESC
            LIMIT 1
          ),
          count_30_days_ago AS (
            SELECT amount, ts
            FROM pdm_feature_counts
            WHERE project = $1
              AND ts <= (SELECT ts - INTERVAL '30 days' FROM current_count)
            ORDER BY ts DESC
            LIMIT 1
          ),
          count_180_days_ago AS (
            SELECT amount, ts
            FROM pdm_feature_counts
            WHERE project = $1
              AND ts <= (SELECT ts - INTERVAL '180 days' FROM current_count)
            ORDER BY ts DESC
            LIMIT 1
          )
          SELECT 
            COALESCE((SELECT amount FROM current_count), 0) AS current_amount,
            COALESCE((SELECT amount FROM count_30_days_ago), 0) AS past_amount,
            COALESCE((SELECT amount FROM count_180_days_ago), 0) AS past_180_amount,
            COALESCE((SELECT ts FROM current_count), NOW()) AS current_ts,
            COALESCE((SELECT ts FROM count_30_days_ago), NOW() - INTERVAL '30 days') AS past_ts,
            COALESCE((SELECT ts FROM count_180_days_ago), NOW() - INTERVAL '180 days') AS past_180_ts
        `,
          [proj.id],
        )
        .then((results) => {
          if (results.rows.length === 0) {
            return {
              id: proj.id,
              last30Days: null,
              last180Days: null,
              currentAmount: 0,
              pastAmount: 0,
              remaining: null,
              etaDays: null,
            };
          }

          const row = results.rows[0];
          const currentAmount = parseInt(row.current_amount) || 0;
          const pastAmount = parseInt(row.past_amount) || 0;
          const past180Amount = parseInt(row.past_180_amount) || 0;
          const last30Days = Math.max(0, currentAmount - pastAmount);
          const last180Days = Math.max(0, currentAmount - past180Amount);

          // Calculate remaining and ETA from chart data (same logic as /projects/:id/stats)
          if (proj.statistics && proj.statistics.count) {
            return pool
              .query(
                `
                SELECT ts, amount
                FROM pdm_feature_counts
                WHERE project = $1
                ORDER BY ts ASC
              `,
                [proj.id],
              )
              .then((chartResults) => {
                const rows = chartResults.rows || [];
                const currentAmountFromChart =
                  rows.length > 0 ? parseInt(rows[rows.length - 1].amount) || 0 : 0;

                // Calculate remaining
                const totalToIntegrate =
                  typeof proj.statistics?.total_expected === "number"
                    ? proj.statistics.total_expected
                    : typeof proj.statistics?.to_integrate === "number"
                      ? proj.statistics.to_integrate
                      : typeof proj.statistics?.target === "number"
                        ? proj.statistics.target
                        : null;
                const remaining =
                  totalToIntegrate != null
                    ? Math.max(0, totalToIntegrate - currentAmountFromChart)
                    : null;

          // Calculate ETA based on last 180 days (6 months) average
          // If remaining > 0, calculate ETA; if no changes in 6 months, ETA is infinite
          let etaDays = null;
          if (remaining != null && remaining > 0) {
            if (last180Days != null && last180Days > 0) {
              const avgPerDay = last180Days / 180;
              if (avgPerDay > 0) {
                etaDays = remaining / avgPerDay;
              } else {
                // No changes in 6 months = infinite time
                etaDays = Infinity;
              }
            } else {
              // No data for 180 days or zero changes = infinite time
              etaDays = Infinity;
            }
          }

                return {
                  id: proj.id,
                  last30Days,
                  last180Days,
                  currentAmount,
                  pastAmount,
                  currentTs: row.current_ts,
                  pastTs: row.past_ts,
                  remaining,
                  etaDays,
                };
              })
              .catch(() => {
                return {
                  id: proj.id,
                  last30Days,
                  last180Days,
                  currentAmount,
                  pastAmount,
                  currentTs: row.current_ts,
                  pastTs: row.past_ts,
                  remaining: null,
                  etaDays: null,
                };
              });
          } else {
            return {
              id: proj.id,
              last30Days,
              last180Days,
              currentAmount,
              pastAmount,
              currentTs: row.current_ts,
              pastTs: row.past_ts,
              remaining: null,
              etaDays: null,
            };
          }
        })
        .catch(() => {
          return {
            id: proj.id,
            last30Days: null,
            last180Days: null,
            currentAmount: 0,
            pastAmount: 0,
            remaining: null,
            etaDays: null,
          };
        });
    }),
  )
    .then((stats) => {
      const statsMap = {};
      stats.forEach((s) => {
        statsMap[s.id] = s;
      });

      res.json({
        projects: statsMap,
      });
    })
    .catch((err) => {
      console.error("Error fetching all projects stats:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// Project statistics
app.get("/projects/:id/stats", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.redirect("/error/404");
  }

  const p = projects[req.params.id];
  const allPromises = [];
  const osmUserAuthentified =
    typeof req.query.osm_user === "string" &&
    req.query.osm_user.trim().length > 0;
  const daysToKeep = (day) => {
    if (
      Date.now() - new Date(p.start_date).getTime() <
      1000 * 60 * 60 * 24 * 60
    ) {
      return true;
    } else if (Date.now() - new Date(day).getTime() < 1000 * 60 * 60 * 24) {
      return true;
    } else {
      return day.substring(8, 10) == "01";
    }
  };

  // Fetch Osmose statistics
  allPromises.push(
    Promise.all(
      p.datasources
        .filter((ds) => ds.source === "osmose")
        .map((ds) => {
          const params = {
            item: ds.item,
            class: ds.class,
            start_date: p.start_date,
            country: ds.country,
          };
          return fetch(
            `${CONFIG.OSMOSE_URL}/fr/issues/graph.json?${queryParams(params)}`,
          )
            .then((res) => res.json())
            .then((res) => ({
              label: ds.name,
              data: Object.entries(res.data)
                .filter((e) => daysToKeep(e[0]))
                .map((e) => ({ t: e[0], y: e[1] }))
                .sort((a, b) => a.t.localeCompare(b.t)),
              fill: false,
              borderColor: ds.color || "#c62828",
              lineTension: 0,
            }));
        }),
    ).then((results) => {
      if (
        !results ||
        results.length === 0 ||
        results.filter((r) => r.data && r.data.length > 0).length === 0
      ) {
        return {};
      }

      const nbTasksStart = results
        .map((r) => r.data[0].y)
        .reduce((acc, cur) => acc + cur);
      const nbTasksEnd = results
        .map((r) => r.data[r.data.length - 1].y)
        .reduce((acc, cur) => acc + cur);

      // Find the "à ajouter" datasource (usually the one with lower item ID)
      const addDataSource = p.datasources.find(
        (ds) => ds.source === "osmose" && ds.name && ds.name.toLowerCase().includes("ajouter")
      );
      
      let osmoseEtaDays = null;
      let osmoseRemaining = null;
      
      if (addDataSource) {
        // Find the corresponding chart data
        const addChartData = results.find(
          (r) => r.label === addDataSource.name
        );
        
        if (addChartData && addChartData.data && addChartData.data.length > 0) {
          // Current remaining tasks (last value)
          osmoseRemaining = addChartData.data[addChartData.data.length - 1].y;
          
          // Calculate tasks solved in last 180 days (6 months)
          const now = new Date();
          const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
          
          // Find data point closest to 6 months ago
          let sixMonthsAgoData = null;
          for (let i = addChartData.data.length - 1; i >= 0; i--) {
            const dataDate = new Date(addChartData.data[i].t);
            if (dataDate <= sixMonthsAgo) {
              sixMonthsAgoData = addChartData.data[i];
              break;
            }
          }
          
          // If we have data from 6 months ago, calculate ETA
          if (sixMonthsAgoData && osmoseRemaining > 0) {
            const tasksSolved180d = Math.max(0, sixMonthsAgoData.y - osmoseRemaining);
            
            if (tasksSolved180d > 0) {
              const dailyRate = tasksSolved180d / 180;
              if (dailyRate > 0) {
                osmoseEtaDays = Math.ceil(osmoseRemaining / dailyRate);
              }
              // If dailyRate is 0 or tasksSolved180d is 0, ETA is infinite (null)
            }
            // If no tasks were solved in 6 months, ETA is infinite (remains null)
          }
        }
      }

      return {
        chart: results,
        tasksSolved:
          nbTasksStart - nbTasksEnd > 0 ? nbTasksStart - nbTasksEnd : undefined,
        osmoseRemaining,
        osmoseEtaDays,
      };
    }),
  );

  // Fetch notes counts
  if (p.datasources.find((ds) => ds.source === "notes")) {
    allPromises.push(
      pool
        .query(
          `
			SELECT ts, open, closed
			FROM pdm_note_counts
			WHERE project = $1
			ORDER BY ts ASC
		`,
          [req.params.id],
        )
        .then((results) => ({
          chartNotes:
            results.rows.length > 0
              ? [
                  {
                    label: "Ouvertes",
                    data: results.rows.map((r) => ({ t: r.ts, y: r.open })),
                    fill: false,
                    borderColor: "#c62828",
                    lineTension: 0,
                  },
                  {
                    label: "Résolues",
                    data: results.rows.map((r) => ({ t: r.ts, y: r.closed })),
                    fill: false,
                    borderColor: "#388E3C",
                    lineTension: 0,
                  },
                ]
              : null,
          statClosedNotes:
            results.rows.length > 0
              ? results.rows[results.rows.length - 1].closed >
                results.rows[results.rows.length - 1].open
                ? results.rows[results.rows.length - 1].closed
                : (
                    (results.rows[results.rows.length - 1].closed /
                      results.rows[results.rows.length - 1].open) *
                    100
                  ).toFixed(0) + "%"
              : "0",
          openedNotes:
            results.rows.length > 0 &&
            results.rows[results.rows.length - 1].open,
        })),
    );
  }

  // Fetch feature counts
  if (p.statistics.count) {
    allPromises.push(
      pool
        .query(
          `
			SELECT ts, amount
			FROM pdm_feature_counts
			WHERE project = $1
			ORDER BY ts ASC
		`,
          [req.params.id],
        )
        .then((results) => {
          const rows = results.rows || [];
          const chartData = rows.map((r) => ({ t: r.ts, y: r.amount }));

          const currentAmount =
            rows.length > 0 ? parseInt(rows[rows.length - 1].amount) || 0 : 0;
          const firstAmount =
            rows.length > 0 ? parseInt(rows[0].amount) || 0 : 0;
          const added = rows.length > 0 ? currentAmount - firstAmount : null;

          const computeDelta = (days) => {
            if (rows.length === 0) return null;
            const last = rows[rows.length - 1];
            const cutoff = new Date(
              new Date(last.ts).getTime() - days * 24 * 3600 * 1000,
            );
            let prev = rows[0];
            for (let i = rows.length - 1; i >= 0; i--) {
              if (new Date(rows[i].ts) <= cutoff) {
                prev = rows[i];
                break;
              }
            }
            return Math.max(0, (parseInt(last.amount) || 0) - (parseInt(prev.amount) || 0));
          };

          const addedWeek = computeDelta(7);
          const added30d = computeDelta(30);
          const added180d = computeDelta(180);
          const added365d = computeDelta(365);

          // Optional target/remaining if provided in project config
          const totalToIntegrate =
            typeof p.statistics?.total_expected === "number"
              ? p.statistics.total_expected
              : typeof p.statistics?.to_integrate === "number"
                ? p.statistics.to_integrate
                : typeof p.statistics?.target === "number"
                  ? p.statistics.target
                  : null;
          const remaining =
            totalToIntegrate != null
              ? Math.max(0, totalToIntegrate - currentAmount)
              : null;

          // Calculate ETA based on last 180 days (6 months) average
          // If remaining > 0, calculate ETA; if no changes in 6 months, ETA is infinite
          let etaDays = null;
          if (remaining != null && remaining > 0) {
            if (added180d != null && added180d > 0) {
              const avgPerDay = added180d / 180;
              if (avgPerDay > 0) {
                etaDays = remaining / avgPerDay;
              } else {
                // No changes in 6 months = infinite time
                etaDays = Infinity;
              }
            } else {
              // No data for 180 days or zero changes = infinite time
              etaDays = Infinity;
            }
          }

          // Calculate variations between consecutive measurements
          const variationData = [];
          for (let i = 1; i < chartData.length; i++) {
            const prev = chartData[i - 1];
            const curr = chartData[i];
            const variation = (parseInt(curr.y) || 0) - (parseInt(prev.y) || 0);
            variationData.push({
              t: curr.t,
              y: variation,
            });
          }

          return {
            chart: [
              {
                label: "Nombre dans OSM",
                data: chartData,
                fill: false,
                borderColor: "#388E3C",
                lineTension: 0,
              },
            ],
            variationChart: [
              {
                label: "Variation entre mesures",
                data: variationData,
                fill: true,
                borderColor: "#1976D2",
                backgroundColor: "rgba(25, 118, 210, 0.2)",
                lineTension: 0,
              },
            ],
            added,
            currentAmount,
            remaining,
            etaDays,
            addedWeek,
            added30d,
            added180d,
            added365d,
            remaining,
            totalToIntegrate,
          };
        }),
    );

    allPromises.push(
      pool
        .query(
          `SELECT COUNT(*) AS amount FROM pdm_project_${req.params.id.split("_").pop()}`,
        )
        .then((results) => ({
          count: results.rows.length > 0 && results.rows[0].amount,
        }))
        .catch((err) => {
          console.error(`Error fetching count for project ${req.params.id}:`, err.message);
          return { count: null };
        }),
    );

    if (p.datasources.find((ds) => ds.source === "stats")) {
      allPromises.push(
        pool
          .query(
            `SELECT admin_level, max(nb) AS amount FROM pdm_boundary_tiles WHERE project = $1 GROUP BY admin_level`,
            [req.params.id],
          )
          .then((results) => {
            const maxLevel = {};
            results.rows.forEach((r) => {
              if (!isNaN(parseInt(r.amount))) {
                maxLevel[r.admin_level] = r.amount;
              }
            });
            return Object.keys(maxLevel).length > 0
              ? getMapStatsStyle(p, maxLevel)
              : null;
          })
          .then((mapStyle) => ({ mapStyle }))
          .catch((err) => {
            console.error(`Error fetching map stats for project ${req.params.id}:`, err.message);
            return { mapStyle: null };
          }),
      );
    }
  }

  // Fetch user statistics from DB
  allPromises.push(
    pool
      .query(`SELECT * FROM pdm_leaderboard WHERE project = $1 ORDER BY pos`, [
        req.params.id,
      ])
      .then((results) => ({
        nbContributors: results.rows.length,
        leaderboard: osmUserAuthentified ? results.rows : null,
      }))
      .catch((err) => {
        console.error(`Error fetching leaderboard for project ${req.params.id}:`, err.message);
        return {
          nbContributors: 0,
          leaderboard: null,
        };
      }),
  );

  // Fetch tags statistics
  allPromises.push(
    pool
      .query(
        `
		SELECT k, COUNT(*) AS amount
		FROM (
			SELECT json_object_keys(tags) AS k
			FROM pdm_project_${req.params.id.split("_").pop()}
		) a
		GROUP BY k
		ORDER BY COUNT(*) desc;`,
      )
      .then((results) => {
        if (results.rows.length === 0) {
          return {
            chartKeys: null,
            keysList: [],
          };
        }
        const d = results.rows.filter(
          (r) => r.amount >= results.rows[0].amount / 10,
        );
        return {
          chartKeys: {
            labels: d.map((r) => r.k),
            datasets: [
              {
                label: "Nombre d'objets pour la clé",
                data: d.map((r) => r.amount),
                fill: false,
                backgroundColor: "#1E88E5",
              },
            ],
          },
          keysList: results.rows,
        };
      })
      .catch((err) => {
        console.error(`Error fetching tags statistics for project ${req.params.id}:`, err.message);
        return {
          chartKeys: null,
          keysList: [],
        };
      }),
  );

  // Fetch quality completion statistics (if enabled)
  if (p.quality && p.quality.required_tags && Array.isArray(p.quality.required_tags) && p.quality.required_tags.length > 0) {
    allPromises.push(
      pool
        .query(
          `
          SELECT 
            ts,
            total_objects,
            avg_completion,
            fully_complete,
            partially_complete,
            incomplete
          FROM pdm_quality_stats
          WHERE project = $1
          ORDER BY ts ASC
        `,
          [req.params.id],
        )
        .then((results) => {
          if (results.rows.length === 0) {
            return { qualityStats: null };
          }
          
          return {
            qualityStats: {
              chart: [
                {
                  label: "Complétion moyenne (%)",
                  data: results.rows.map((r) => ({ t: r.ts, y: parseFloat(r.avg_completion) })),
                  fill: false,
                  borderColor: "#4CAF50",
                  lineTension: 0,
                },
                {
                  label: "Objets 100% complets",
                  data: results.rows.map((r) => ({ t: r.ts, y: parseInt(r.fully_complete) })),
                  fill: false,
                  borderColor: "#8BC34A",
                  lineTension: 0,
                },
                {
                  label: "Objets partiellement complets (50-99%)",
                  data: results.rows.map((r) => ({ t: r.ts, y: parseInt(r.partially_complete) })),
                  fill: false,
                  borderColor: "#FFC107",
                  lineTension: 0,
                },
                {
                  label: "Objets incomplets (<50%)",
                  data: results.rows.map((r) => ({ t: r.ts, y: parseInt(r.incomplete) })),
                  fill: false,
                  borderColor: "#F44336",
                  lineTension: 0,
                },
              ],
              current: results.rows.length > 0 ? {
                avg_completion: parseFloat(results.rows[results.rows.length - 1].avg_completion),
                fully_complete: parseInt(results.rows[results.rows.length - 1].fully_complete),
                partially_complete: parseInt(results.rows[results.rows.length - 1].partially_complete),
                incomplete: parseInt(results.rows[results.rows.length - 1].incomplete),
                total_objects: parseInt(results.rows[results.rows.length - 1].total_objects),
              } : null,
              required_tags: p.quality.required_tags,
            },
          };
        })
        .catch((err) => {
          console.error("Error fetching quality stats:", err);
          return { qualityStats: null };
        }),
    );
  }

  // Specific stats for EV charging sockets
  if (req.params.id === "2020-03_evcharging") {
    allPromises.push(
      pool
        .query(
          `
          SELECT
            COALESCE(SUM(CASE WHEN tags ? 'socket:type2' THEN NULLIF(tags->>'socket:type2','')::INT ELSE 0 END),0) AS socket_type2,
            COALESCE(SUM(CASE WHEN tags ? 'socket:type3' THEN NULLIF(tags->>'socket:type3','')::INT ELSE 0 END),0) AS socket_type3,
            COALESCE(SUM(CASE WHEN tags ? 'socket:ccs' THEN NULLIF(tags->>'socket:ccs','')::INT ELSE 0 END),0) AS socket_ccs,
            COALESCE(SUM(CASE WHEN tags ? 'socket:chademo' THEN NULLIF(tags->>'socket:chademo','')::INT ELSE 0 END),0) AS socket_chademo
          FROM pdm_project_evcharging
        `,
        )
        .then((results) => ({
          sockets: results.rows.length > 0 ? results.rows[0] : null,
        }))
        .catch(() => ({ sockets: null })),
    );
  }

  Promise.allSettled(allPromises).then((results) => {
    let toSend = {};
    if (typeof results == "object" && results != null) {
      results.forEach((r) => {
        if (r != null && r.status === "fulfilled") {
          Object.entries(r.value).forEach((e) => {
            if (!toSend[e[0]]) {
              toSend[e[0]] = e[1];
            } else if (e[0] === "chart") {
              toSend.chart = toSend.chart.concat(e[1]);
            }
          });
        }
      });
    }

    // If a chart dataset corresponds to "à importer", use it as remaining/total
    if (Array.isArray(toSend.chart)) {
      const importerDs = toSend.chart.find(
        (ds) =>
          ds &&
          typeof ds.label === "string" &&
          ds.label.toLowerCase().includes("import"),
      );
      if (importerDs && Array.isArray(importerDs.data) && importerDs.data.length > 0) {
        const values = importerDs.data.map((p) => Number(p.y) || 0);
        const remainingImport = values[values.length - 1];
        const totalImport = values.reduce((m, v) => Math.max(m, v), 0);
        toSend.remaining = remainingImport;
        toSend.totalToIntegrate = totalImport;
      }
      
      // Calculate variation chart from the main dataset (first dataset with "Nombre" or "dans OSM" in label)
      const mainDataset = toSend.chart.find(
        (ds) =>
          ds &&
          typeof ds.label === "string" &&
          (ds.label.toLowerCase().includes("nombre") || ds.label.toLowerCase().includes("dans osm") || ds.label.toLowerCase().includes("objets"))
      );
      if (mainDataset && Array.isArray(mainDataset.data) && mainDataset.data.length > 1) {
        const variationData = [];
        for (let i = 1; i < mainDataset.data.length; i++) {
          const prev = mainDataset.data[i - 1];
          const curr = mainDataset.data[i];
          const variation = (Number(curr.y) || 0) - (Number(prev.y) || 0);
          variationData.push({
            t: curr.t,
            y: variation,
          });
        }
        toSend.variationChart = [
          {
            label: "Variation entre mesures",
            data: variationData,
            fill: true,
            borderColor: "#1976D2",
            backgroundColor: "rgba(25, 118, 210, 0.2)",
            lineTension: 0,
          },
        ];

        // Calculate monthly variation chart
        // Use the main dataset (absolute values) to calculate monthly variations correctly
        // The variation for each month = end of month value - end of previous month value
        if (mainDataset && Array.isArray(mainDataset.data) && mainDataset.data.length > 0) {
          // Find the most recent year in the data
          let targetYear = new Date().getFullYear();
          const yearsInData = new Set();
          mainDataset.data.forEach(point => {
            if (point.t) {
              const date = new Date(point.t);
              if (!isNaN(date.getTime())) {
                yearsInData.add(date.getFullYear());
              }
            }
          });
          if (yearsInData.size > 0) {
            // Use the most recent year in the data
            targetYear = Math.max(...Array.from(yearsInData));
          }
          
          const monthlyEndValues = {};

          // Initialize all 12 months with null
          for (let month = 1; month <= 12; month++) {
            const monthKey = targetYear + '-' + String(month).padStart(2, '0');
            monthlyEndValues[monthKey] = null;
          }

          // Process all data points to find the end value (last measurement) for each month
          mainDataset.data.forEach(point => {
            if (point.t && point.y !== undefined && point.y !== null) {
              const date = new Date(point.t);
              const year = date.getFullYear();
              const month = date.getMonth() + 1; // 1-12

              // Only include target year data (most recent year in data)
              if (year === targetYear) {
                const monthKey = year + '-' + String(month).padStart(2, '0');
                if (monthlyEndValues.hasOwnProperty(monthKey)) {
                  const value = Number(point.y) || 0;
                  const pointDate = new Date(point.t);

                  // Keep the latest value for each month (end of month value)
                  if (monthlyEndValues[monthKey] === null) {
                    monthlyEndValues[monthKey] = { value: value, date: pointDate };
                  } else if (pointDate > monthlyEndValues[monthKey].date) {
                    monthlyEndValues[monthKey] = { value: value, date: pointDate };
                  }
                }
              }
            }
          });

          // For months without data, try to use the previous month's end value
          // This handles cases where there's no measurement in a given month
          for (let month = 1; month <= 12; month++) {
            const monthKey = targetYear + '-' + String(month).padStart(2, '0');
            if (monthlyEndValues[monthKey] === null && month > 1) {
              const prevMonth = month - 1;
              const prevMonthKey = targetYear + '-' + String(prevMonth).padStart(2, '0');
              if (monthlyEndValues[prevMonthKey] !== null) {
                // Use previous month's end value as this month's value if no data
                monthlyEndValues[monthKey] = {
                  value: monthlyEndValues[prevMonthKey].value,
                  date: new Date(targetYear, month - 1, 1)
                };
              }
            }
          }

          // Convert to array format for chart, calculating variation for each month
          // Variation = end of current month - end of previous month
          const monthlyChartData = [];

          for (let month = 1; month <= 12; month++) {
            const monthKey = targetYear + '-' + String(month).padStart(2, '0');
            const monthEndValue = monthlyEndValues[monthKey];

            let monthValue = 0;
            if (monthEndValue !== null) {
              if (month === 1) {
                // For the first month, we need to find the value at the end of the previous year
                // Look for the last measurement of the previous year
                let prevYearEndValue = null;
                for (let i = mainDataset.data.length - 1; i >= 0; i--) {
                  const point = mainDataset.data[i];
                  if (point.t && point.y !== undefined && point.y !== null) {
                    const date = new Date(point.t);
                    if (date.getFullYear() === targetYear - 1) {
                      prevYearEndValue = Number(point.y) || 0;
                      break;
                    }
                  }
                }
                if (prevYearEndValue !== null) {
                  monthValue = monthEndValue.value - prevYearEndValue;
                } else {
                  // If no previous year data, variation is 0 or the value itself
                  monthValue = monthEndValue.value;
                }
              } else {
                // For other months, variation = current month end - previous month end
                const prevMonth = month - 1;
                const prevMonthKey = targetYear + '-' + String(prevMonth).padStart(2, '0');
                const prevMonthEndValue = monthlyEndValues[prevMonthKey];
                if (prevMonthEndValue !== null) {
                  monthValue = monthEndValue.value - prevMonthEndValue.value;
                }
              }
            }

            monthlyChartData.push({
              t: new Date(targetYear, month - 1, 1).toISOString(),
              y: monthValue
            });
          }

          // Add monthly variation chart to response
          toSend.monthlyVariationChart = [
            {
              label: "Variation mensuelle",
              data: monthlyChartData,
              fill: true,
              borderColor: "#7B1FA2",
              backgroundColor: "rgba(123, 31, 162, 0.2)",
              lineTension: 0.3,
              pointRadius: 4,
              pointHoverRadius: 6
            }
          ];
        }
      }
    }

    // Derive averages and ETA once all data merged
    const contributors = toSend.nbContributors || 0;
    if (toSend.added != null && contributors > 0) {
      toSend.avgPerContributor = toSend.added / contributors;
    }
    if (toSend.remaining != null && contributors > 0) {
      toSend.remainingPerContributor = toSend.remaining / contributors;
    }
    // Calculate ETA based on last 180 days (6 months) average only
    // If remaining > 0, calculate ETA; if no changes in 6 months, ETA is infinite
    if (toSend.remaining != null && toSend.remaining > 0) {
      if (toSend.added180d != null && toSend.added180d > 0) {
        const dailyRate = toSend.added180d / 180;
        if (dailyRate > 0) {
          toSend.etaDays = toSend.remaining / dailyRate;
        } else {
          // No changes in 6 months = infinite time
          toSend.etaDays = Infinity;
        }
      } else {
        // No data for 180 days or zero changes = infinite time
        toSend.etaDays = Infinity;
      }
    }

    // Estimations par commune (base 34 874 communes INSEE)
    const NB_COMMUNES = 34874;
    if (toSend.currentAmount != null) {
      toSend.avgPerCommune = toSend.currentAmount / NB_COMMUNES;
    }
    if (contributors > 0) {
      toSend.contributorsPerCommune = contributors / NB_COMMUNES;
    }

    // Add project metadata for chart display
    toSend.projectStartDate = p.start_date;
    toSend.projectEndDate = p.end_date;
    toSend.projectName = p.title;
    // Extract geographic zone from OSH_PBF_URL (e.g., "france" from "france-internal.osh.pbf")
    const pbfUrl = CONFIG.OSH_PBF_URL || "";
    const zoneMatch = pbfUrl.match(/([^\/]+)-internal\.osh\.pbf/);
    toSend.geographicZone = zoneMatch ? zoneMatch[1].charAt(0).toUpperCase() + zoneMatch[1].slice(1) : "France";

    res.send(toSend);
  });
});

// Zone statistics endpoint
app.get("/projects/:id/zones/:boundary_id/stats", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  const p = projects[req.params.id];
  // Remove leading minus sign if present (OSM relation IDs can be negative)
  const boundaryIdStr = req.params.boundary_id.replace(/^-/, '');
  const boundaryId = parseInt(boundaryIdStr);

  if (isNaN(boundaryId)) {
    return res.status(400).json({ error: "Invalid boundary ID" });
  }

  // Get boundary info and feature counts
  Promise.all([
    pool.query(
      `
      SELECT osm_id, name, admin_level, tags
      FROM pdm_boundary
      WHERE osm_id = $1 OR osm_id = -$1
    `,
      [boundaryId],
    ),
    pool.query(
      `
      SELECT ts, amount
      FROM pdm_feature_counts_per_boundary
      WHERE project = $1 AND (boundary = $2 OR boundary = -$2)
      ORDER BY ts ASC
    `,
      [req.params.id, boundaryId],
    ),
    pool.query(
      `
      SELECT DISTINCT project
      FROM pdm_feature_counts_per_boundary
      WHERE boundary = $1 OR boundary = -$1
    `,
      [boundaryId],
    ),
    pool.query(
      `
      SELECT COUNT(DISTINCT osmid) as count
      FROM pdm_features_boundary
      WHERE project = $1 AND (boundary = $2 OR boundary = -$2)
        AND (end_ts IS NULL OR end_ts > NOW())
    `,
      [req.params.id, boundaryId],
    ),
    // Get INSEE data for this boundary
    pool.query(
      `
      SELECT i.insee_code, i.name, i.population, i.budget_total, i.budget_year
      FROM pdm_boundary_insee bi
      JOIN pdm_insee_data i ON bi.insee_code = i.insee_code
      WHERE bi.boundary_id = $1 OR bi.boundary_id = -$1
      LIMIT 1
    `,
      [boundaryId],
    ),
  ])
    .then(([boundaryResult, countsResult, projectsResult, objectsResult, inseeResult]) => {
      if (boundaryResult.rows.length === 0) {
        return res.status(404).json({ error: "Boundary not found" });
      }

      const boundary = boundaryResult.rows[0];
      const counts = countsResult.rows.map((r) => ({
        t: r.ts,
        y: parseInt(r.amount) || 0,
      }));
      const otherProjects = projectsResult.rows
        .map((r) => r.project)
        .filter((pid) => pid !== req.params.id)
        .map((pid) => {
          const proj = projects[pid];
          return proj ? { id: pid, title: proj.title, icon: proj.icon } : null;
        })
        .filter((p) => p !== null);

      const currentAmount =
        counts.length > 0 ? counts[counts.length - 1].y : 0;
      const firstAmount = counts.length > 0 ? counts[0].y : 0;
      const added = counts.length > 0 ? currentAmount - firstAmount : 0;
      
      // Get INSEE data if available
      const inseeData = inseeResult.rows.length > 0 ? inseeResult.rows[0] : null;
      const currentYear = new Date().getFullYear();
      const currentYearCount = counts.filter(c => {
        const countYear = new Date(c.t).getFullYear();
        return countYear === currentYear;
      });
      const currentYearAmount = currentYearCount.length > 0 ? currentYearCount[currentYearCount.length - 1].y : currentAmount;
      
      // Calculate objects per inhabitant
      const objectsPerInhabitant = inseeData && inseeData.population && inseeData.population > 0
        ? (currentYearAmount / inseeData.population).toFixed(2)
        : null;

      const computeDelta = (days) => {
        if (counts.length === 0) return null;
        const last = counts[counts.length - 1];
        const cutoff = new Date(
          new Date(last.t).getTime() - days * 24 * 3600 * 1000,
        );
        let prev = counts[0];
        for (let i = counts.length - 1; i >= 0; i--) {
          if (new Date(counts[i].t) <= cutoff) {
            prev = counts[i];
            break;
          }
        }
        return Math.max(0, (parseInt(last.y) || 0) - (parseInt(prev.y) || 0));
      };

      const response = {
        project: {
          id: req.params.id,
          name: p.title,
        },
        boundary: {
          id: Math.abs(parseInt(boundary.osm_id)),
          name: boundary.name,
          admin_level: parseInt(boundary.admin_level),
          tags: boundary.tags,
        },
        counts: {
          chart: [
            {
              label: "Nombre d'objets",
              data: counts,
              fill: false,
              borderColor: "#388E3C",
              lineTension: 0,
            },
          ],
          current: currentAmount,
          first: firstAmount,
          added: added,
          addedWeek: computeDelta(7),
          added30d: computeDelta(30),
          added180d: computeDelta(180),
          added365d: computeDelta(365),
        },
        objects: {
          current: parseInt(objectsResult.rows[0]?.count || 0),
        },
        otherProjects: otherProjects,
        insee: inseeData ? {
          population: inseeData.population,
          budget_total: inseeData.budget_total,
          budget_year: inseeData.budget_year,
          objects_per_inhabitant: objectsPerInhabitant ? parseFloat(objectsPerInhabitant) : null,
          current_year_objects: currentYearAmount,
        } : null,
      };

      // Add quality stats if available
      if (p.quality && p.quality.required_tags) {
        return pool
          .query(
            `
            SELECT 
              qs.ts,
              qs.total_objects,
              qs.avg_completion,
              qs.fully_complete,
              qs.partially_complete,
              qs.incomplete
            FROM pdm_quality_stats qs
            WHERE qs.project = $1
            ORDER BY qs.ts ASC
          `,
            [req.params.id],
          )
          .then((qualityResult) => {
            if (qualityResult.rows.length > 0) {
              response.quality = {
                chart: [
                  {
                    label: "Complétion moyenne",
                    data: qualityResult.rows.map((r) => ({
                      t: r.ts,
                      y: parseFloat(r.avg_completion) || 0,
                    })),
                    fill: false,
                    borderColor: "#1976D2",
                    lineTension: 0,
                  },
                  {
                    label: "Objets complets (100%)",
                    data: qualityResult.rows.map((r) => ({
                      t: r.ts,
                      y: parseInt(r.fully_complete) || 0,
                    })),
                    fill: false,
                    borderColor: "#388E3C",
                    lineTension: 0,
                  },
                  {
                    label: "Objets partiellement complets (50-99%)",
                    data: qualityResult.rows.map((r) => ({
                      t: r.ts,
                      y: parseInt(r.partially_complete) || 0,
                    })),
                    fill: false,
                    borderColor: "#FFC107",
                    lineTension: 0,
                  },
                  {
                    label: "Objets incomplets (<50%)",
                    data: qualityResult.rows.map((r) => ({
                      t: r.ts,
                      y: parseInt(r.incomplete) || 0,
                    })),
                    fill: false,
                    borderColor: "#F44336",
                    lineTension: 0,
                  },
                ],
                current: {
                  avg_completion: parseFloat(
                    qualityResult.rows[qualityResult.rows.length - 1]
                      .avg_completion,
                  ),
                  fully_complete: parseInt(
                    qualityResult.rows[qualityResult.rows.length - 1]
                      .fully_complete,
                  ),
                  partially_complete: parseInt(
                    qualityResult.rows[qualityResult.rows.length - 1]
                      .partially_complete,
                  ),
                  incomplete: parseInt(
                    qualityResult.rows[qualityResult.rows.length - 1].incomplete,
                  ),
                  total_objects: parseInt(
                    qualityResult.rows[qualityResult.rows.length - 1]
                      .total_objects,
                  ),
                },
                required_tags: p.quality.required_tags,
              };
            }
            res.json(response);
          })
          .catch((err) => {
            console.error("Error fetching quality stats:", err);
            res.json(response);
          });
      } else {
        res.json(response);
      }
    })
    .catch((err) => {
      console.error("Error fetching zone stats:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// Zone objects export endpoint
app.get("/projects/:id/zones/:boundary_id/objects", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  const p = projects[req.params.id];
  // Remove leading minus sign if present (OSM relation IDs can be negative)
  const boundaryIdStr = req.params.boundary_id.replace(/^-/, '');
  const boundaryId = parseInt(boundaryIdStr);
  const projectTableSuffix = req.params.id.split("_").pop();

  if (isNaN(boundaryId)) {
    return res.status(400).json({ error: "Invalid boundary ID" });
  }

  // Try to get objects from the project view (which combines point and polygon tables)
  // projectTableSuffix is safe because it's extracted from a validated project ID
  const projectTableName = `pdm_project_${projectTableSuffix.replace(/[^a-z0-9_]/gi, "")}`;
  
  pool
    .query(
      `
      SELECT DISTINCT fb.osmid, p.name, p.tags
      FROM pdm_features_boundary fb
      JOIN ${projectTableName} p ON fb.osmid = p.osm_id
      WHERE fb.project = $1 
        AND (fb.boundary = $2 OR fb.boundary = -$2)
        AND (fb.end_ts IS NULL OR fb.end_ts > NOW())
      ORDER BY p.name, fb.osmid
    `,
      [req.params.id, boundaryId],
    )
    .then((result) => {
      res.json(
        result.rows.map((r) => ({
          osm_id: r.osmid,
          name: r.name,
          tags: typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags,
        })),
      );
    })
    .catch((err) => {
      console.error("Error fetching zone objects:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// Search zones by name or INSEE code
app.get("/projects/:id/zones-search", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  const query = req.query.q;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: "Query too short (minimum 2 characters)" });
  }

  const searchTerm = `%${query.trim()}%`;

  pool
    .query(
      `
      SELECT osm_id, name, admin_level, tags
      FROM pdm_boundary
      WHERE (name ILIKE $1 
        OR (tags ? 'ref:INSEE' AND (tags->'ref:INSEE')::text ILIKE $1))
        AND admin_level IN (8, 9, 10)
      ORDER BY 
        CASE 
          WHEN name ILIKE $2 THEN 1
          WHEN tags ? 'ref:INSEE' AND (tags->'ref:INSEE')::text = $3 THEN 2
          ELSE 3
        END,
        name
      LIMIT 20
    `,
      [searchTerm, query.trim(), query.trim()],
    )
    .then((result) => {
      res.json({
        zones: result.rows.map((r) => {
          // tags is hstore, so access it directly
          const insee = r.tags && r.tags['ref:INSEE'] ? r.tags['ref:INSEE'] : null;
          return {
            id: Math.abs(parseInt(r.osm_id)), // Always use positive ID
            name: r.name,
            admin_level: parseInt(r.admin_level),
            insee: insee,
          };
        }),
      });
    })
    .catch((err) => {
      console.error("Error searching zones:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API: Deletions statistics for a project
app.get("/projects/:id/deletions", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  const p = projects[req.params.id];

  // Get deletions grouped by day
  pool
    .query(
      `
      SELECT 
        DATE(ts) as date,
        COUNT(*) as deletion_count,
        COUNT(DISTINCT userid) as user_count
      FROM pdm_changes
      WHERE project = $1
        AND action = 'delete'
      GROUP BY DATE(ts)
      ORDER BY DATE(ts) ASC
    `,
      [req.params.id],
    )
    .then((results) => {
      // Find the most recent month
      if (results.rows.length === 0) {
        return res.json({
          chart: [],
          changesets: [],
        });
      }
      
      const allDates = results.rows.map(r => new Date(r.date));
      const mostRecentDate = new Date(Math.max(...allDates));
      const mostRecentMonth = new Date(mostRecentDate.getFullYear(), mostRecentDate.getMonth(), 1);
      
      // Aggregate: monthly for old data, daily for the most recent month
      const aggregatedData = new Map();
      
      results.rows.forEach((r) => {
        const date = new Date(r.date);
        const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
        const isRecentMonth = monthStart.getTime() === mostRecentMonth.getTime();
        
        const key = isRecentMonth ? date.toISOString().split('T')[0] : monthStart.toISOString().split('T')[0];
        
        if (!aggregatedData.has(key)) {
          aggregatedData.set(key, {
            t: isRecentMonth ? date : monthStart,
            y: 0,
            maxUsers: 0
          });
        }
        
        const entry = aggregatedData.get(key);
        entry.y += parseInt(r.deletion_count) || 0;
        if (r.user_count) {
          // For monthly aggregation, we'll use the max user count per day
          entry.maxUsers = Math.max(entry.maxUsers, parseInt(r.user_count) || 0);
        }
      });
      
      const chartData = Array.from(aggregatedData.values()).map(entry => ({
        t: entry.t,
        y: entry.y,
        users: entry.maxUsers || 0
      })).sort((a, b) => new Date(a.t) - new Date(b.t));

      // Get changesets with deletions (grouped by changeset_id, or by user and date if changeset_id is null)
      // First check if changeset_id column exists
      return pool
        .query(
          `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'pdm_changes' AND column_name = 'changeset_id'
          LIMIT 1
        `
        )
        .then((colCheck) => {
          const hasChangesetId = colCheck.rows.length > 0;
          
          // Build query based on whether changeset_id column exists
          const changesetQuery = hasChangesetId
            ? `
              SELECT 
                DATE(ts) as date,
                username,
                userid,
                changeset_id,
                COUNT(*) as deletion_count,
                MIN(ts) as first_deletion,
                MAX(ts) as last_deletion
              FROM pdm_changes
              WHERE project = $1
                AND action = 'delete'
              GROUP BY DATE(ts), username, userid, changeset_id
              ORDER BY DATE(ts) DESC, deletion_count DESC
              LIMIT 100
            `
            : `
              SELECT 
                DATE(ts) as date,
                username,
                userid,
                NULL::BIGINT as changeset_id,
                COUNT(*) as deletion_count,
                MIN(ts) as first_deletion,
                MAX(ts) as last_deletion
              FROM pdm_changes
              WHERE project = $1
                AND action = 'delete'
              GROUP BY DATE(ts), username, userid
              ORDER BY DATE(ts) DESC, deletion_count DESC
              LIMIT 100
            `;
          
          return pool.query(changesetQuery, [req.params.id]);
        })
        .then((changesetResults) => {
          const changesets = changesetResults.rows.map((r) => {
            const changesetId = r.changeset_id != null ? parseInt(r.changeset_id) : null;
            const dateStr = new Date(r.date).toISOString().split('T')[0];
            const nextDayStr = new Date(new Date(r.date).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            
            // Construct URLs
            let achaviUrl;
            let osmChangesetUrl = null;
            
            if (changesetId) {
              // Use changeset ID directly
              achaviUrl = `https://overpass-api.de/achavi/?changeset=${changesetId}`;
              osmChangesetUrl = `https://www.openstreetmap.org/changeset/${changesetId}`;
            } else {
              // Fallback: approximate changeset search by user and date range
              achaviUrl = r.username 
                ? `https://overpass-api.de/achavi/?user=${encodeURIComponent(r.username)}&time=${dateStr}/${nextDayStr}`
                : `https://overpass-api.de/achavi/?time=${dateStr}/${nextDayStr}`;
            }
            
            // User profile URL on osm.org
            const osmUserUrl = r.userid 
              ? `https://www.openstreetmap.org/user/${encodeURIComponent(r.username || '')}`
              : null;
            
            return {
              date: r.date,
              username: r.username || 'Inconnu',
              userid: r.userid != null ? parseInt(r.userid) : null,
              changeset_id: changesetId,
              deletion_count: parseInt(r.deletion_count) || 0,
              first_deletion: r.first_deletion,
              last_deletion: r.last_deletion,
              achavi_url: achaviUrl,
              osm_changeset_url: osmChangesetUrl,
              osm_user_url: osmUserUrl,
            };
          });

          res.json({
            chart: chartData,
            changesets: changesets,
          });
        })
        .catch((err) => {
          console.error("Error fetching changesets:", err);
          // Return chart data even if changesets query fails
          res.json({
            chart: chartData,
            changesets: [],
          });
        });
    })
    .catch((err) => {
      console.error("Error fetching deletions:", err);
      res.status(500).json({ error: "Internal server error", details: err.message });
    });
});

// Zone details page
app.get("/projects/:id/zones/:boundary_id", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.redirect("/error/404");
  }

  const p = projects[req.params.id];
  // Remove leading minus sign if present (OSM relation IDs can be negative)
  const boundaryIdStr = req.params.boundary_id.replace(/^-/, '');
  const boundaryId = parseInt(boundaryIdStr);

  if (isNaN(boundaryId)) {
    return res.redirect("/error/404");
  }

  const all = foldProjects(projects);
  const isActive =
    all.current.length > 0 &&
    all.current.find((p) => p.id === req.params.id) !== undefined;

  // Get boundary info
  // Search for both positive and negative IDs since OSM relation IDs can be negative
  pool
    .query(
      `
      SELECT osm_id, name, admin_level, tags
      FROM pdm_boundary
      WHERE osm_id = $1 OR osm_id = -$1
    `,
      [boundaryId],
    )
    .then((result) => {
      if (result.rows.length === 0) {
        return res.redirect("/error/404");
      }

      const boundary = result.rows[0];
      const boundaryData = {
        id: Math.abs(parseInt(boundary.osm_id)),
        name: boundary.name,
        admin_level: parseInt(boundary.admin_level),
        tags: boundary.tags,
      };

      // Check if it's a city (admin_level 8 or 9) and try to get Commons image
      const isCity = boundaryData.admin_level === 8 || boundaryData.admin_level === 9;
      let commonsImagePromise = Promise.resolve(null);

      if (isCity) {
        // Search for images related to the city name
        const searchQuery = `${boundary.name} France`;
        commonsImagePromise = fetch(
          `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(searchQuery)}&srnamespace=6&srlimit=5&origin=*`,
        )
          .then((res) => res.json())
          .then((data) => {
            if (data.query && data.query.search && data.query.search.length > 0) {
              // Get the first image and fetch its details
              const firstImage = data.query.search[0];
              return fetch(
                `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200&titles=${encodeURIComponent(firstImage.title)}&origin=*`,
              )
                .then((res) => res.json())
                .then((imgData) => {
                  const pages = imgData.query?.pages;
                  if (pages) {
                    const pageId = Object.keys(pages)[0];
                    const page = pages[pageId];
                    if (page.imageinfo && page.imageinfo[0]) {
                      const imgInfo = page.imageinfo[0];
                      return {
                        url: imgInfo.url,
                        thumburl: imgInfo.thumburl || imgInfo.url,
                        thumbwidth: imgInfo.thumbwidth || 800,
                        thumbheight: imgInfo.thumbheight || 600,
                        title: firstImage.title,
                        attribution: imgInfo.extmetadata?.Artist?.value || imgInfo.extmetadata?.Attribution?.value || null,
                        license: imgInfo.extmetadata?.LicenseShortName?.value || imgInfo.extmetadata?.License?.value || null,
                        author: imgInfo.extmetadata?.Artist?.value || imgInfo.extmetadata?.Attribution?.value || null,
                      };
                    }
                  }
                  return null;
                })
                .catch((err) => {
                  console.error("Error fetching Commons image details:", err);
                  return null;
                });
            }
            return null;
          })
          .catch((err) => {
            console.error("Error searching Commons:", err);
            return null;
          });
      }

      // Get all projects that have data for this boundary
      return pool
        .query(
          `
          SELECT DISTINCT project
          FROM pdm_feature_counts_per_boundary
          WHERE boundary = $1 OR boundary = -$1
        `,
          [boundaryId],
        )
        .then((projectsResult) => {
          const allProjectsForZone = projectsResult.rows
            .map((r) => r.project)
            .map((pid) => {
              const proj = projects[pid];
              return proj ? { id: pid, title: proj.title, icon: proj.icon } : null;
            })
            .filter((p) => p !== null)
            .sort((a, b) => a.title.localeCompare(b.title));

          return commonsImagePromise.then((commonsImage) => {
            res.render(
              "pages/zone",
              Object.assign(
                {
                  CONFIG,
                  isActive,
                  project: p,
                  boundary: boundaryData,
                  commonsImage: commonsImage,
                  projects: projects, // Pass all projects for icons
                  allProjectsForZone: allProjectsForZone, // All projects with data for this zone
                },
                p,
              ),
            );
          });
        });
    })
    .catch((err) => {
      console.error("Error fetching zone:", err);
      res.redirect("/error/404");
    });
});

// Notes France monitoring page
app.get("/notes-france", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  // Requête pour obtenir les données de comptage et calculer les notes créées et fermées
  const statsQuery = pool.query(
    `
    WITH ordered_data AS (
      SELECT 
        ts,
        open as total_open,
        closed as total_closed,
        (open + closed) as total,
        LAG((open + closed)) OVER (ORDER BY ts) as prev_total,
        LAG(closed) OVER (ORDER BY ts) as prev_closed
      FROM pdm_note_counts_global
      ORDER BY ts ASC
    )
    SELECT 
      ts,
      total_open,
      total_closed,
      total,
      GREATEST(0, total - COALESCE(prev_total, 0)) as created,
      GREATEST(0, total_closed - COALESCE(prev_closed, 0)) as closed_daily
    FROM ordered_data
    WHERE ts >= NOW() - INTERVAL '30 days'
    ORDER BY ts ASC
  `,
  );

  // Récupérer les notes récentes (nouvelles et résolues) via l'API OSM
  // La bbox doit être limitée à 25 degrés (max 5x5)
  // On utilise une bbox centrée sur la France (environ 4x4 degrés)
  // On récupère plus de notes pour filtrer les nouvelles et résolues récentes
  const notesQuery = Promise.all([
    // Notes ouvertes récentes (nouvelles)
    fetch(`https://api.openstreetmap.org/api/0.6/notes.json?bbox=2.0,46.0,6.0,50.0&limit=100&closed=0`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .catch((err) => {
        console.error("Error fetching open OSM notes:", err);
        return { features: [] };
      }),
    // Notes fermées récentes (résolues)
    fetch(`https://api.openstreetmap.org/api/0.6/notes.json?bbox=2.0,46.0,6.0,50.0&limit=100&closed=1`)
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP error! status: ${res.status}`);
        }
        return res.json();
      })
      .catch((err) => {
        console.error("Error fetching closed OSM notes:", err);
        return { features: [] };
      })
  ])
    .then(([openNotesData, closedNotesData]) => {
      // L'API OSM peut retourner soit un objet GeoJSON avec features, soit directement un tableau
      let allFeatures = [];
      
      [openNotesData, closedNotesData].forEach(jsonData => {
        if (jsonData.features && Array.isArray(jsonData.features)) {
          allFeatures = allFeatures.concat(jsonData.features);
        } else if (Array.isArray(jsonData)) {
          allFeatures = allFeatures.concat(jsonData);
        } else if (jsonData.type === 'FeatureCollection' && jsonData.features) {
          allFeatures = allFeatures.concat(jsonData.features);
        }
      });
      
      const notes = allFeatures.map(feature => {
        // Le format OSM est un FeatureCollection avec des Feature
        const props = feature.properties || {};
        const geometry = feature.geometry || {};
        const comments = props.comments || [];
        const firstComment = comments[0] || {};
        const lastComment = comments[comments.length - 1] || {};
        const coords = geometry.coordinates || [];
        
        return {
          id: props.id,
          lat: coords[1] || 0,
          lon: coords[0] || 0,
          status: props.status || 'open',
          date_created: props.date_created,
          date_closed: props.closed_at,
          comment: firstComment.text || '',
          comment_date: firstComment.date || props.date_created,
          last_comment_date: lastComment.date || props.date_created,
          url: `https://www.openstreetmap.org/note/${props.id}`
        };
      });
      
      // Trier par date de dernière activité (création ou dernier commentaire) et prendre les 50 plus récentes
      notes.sort((a, b) => {
        const dateA = new Date(a.date_closed || a.last_comment_date || a.date_created);
        const dateB = new Date(b.date_closed || b.last_comment_date || b.date_created);
        return dateB - dateA;
      });
      
      return notes.slice(0, 50);
    })
    .catch((err) => {
      console.error("Error fetching OSM notes:", err);
      return [];
    });

  Promise.all([statsQuery, notesQuery])
    .then(([statsResult, notes]) => {
      const chartData = statsResult.rows.map((r) => ({
        t: r.ts,
        open: parseInt(r.total_open) || 0,
        closed: parseInt(r.total_closed) || 0,
        total: parseInt(r.total) || 0,
        created: parseInt(r.created) || 0,
        closed_daily: parseInt(r.closed_daily) || 0,
      }));
      
      // If JSON format requested
      if (req.query.format === "json" || req.path.startsWith("/api/")) {
        return res.json(chartData);
      }
      
      res.render("pages/notes_france", {
        CONFIG,
        chartData,
        recentNotes: notes,
      });
    })
    .catch((err) => {
      console.error("Error fetching notes France stats:", err);
      res.redirect("/error/500");
    });
});

// API endpoint for notes France JSON
app.get("/api/notes-france", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  pool
    .query(
      `
      SELECT 
        ts,
        open as total_open,
        closed as total_closed,
        (open + closed) as total
      FROM pdm_note_counts_global
      ORDER BY ts ASC
    `,
    )
    .then((result) => {
      res.json(
        result.rows.map((r) => ({
          t: r.ts,
          open: parseInt(r.total_open) || 0,
          closed: parseInt(r.total_closed) || 0,
          total: parseInt(r.total) || 0,
        })),
      );
    })
    .catch((err) => {
      console.error("Error fetching notes France stats:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API endpoint for notes by boundaries
app.get("/api/notes-france/boundaries", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  // Récupérer les boundary IDs depuis les paramètres de requête
  const boundaryIdsParam = req.query.boundaries || req.query.boundary;
  if (!boundaryIdsParam) {
    return res.status(400).json({ error: "Missing 'boundaries' parameter. Provide comma-separated boundary IDs." });
  }

  // Parser les boundary IDs (peuvent être séparés par des virgules)
  const boundaryIds = boundaryIdsParam
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

  if (boundaryIds.length === 0) {
    return res.status(400).json({ error: "Invalid boundary IDs provided" });
  }

  // Récupérer les données de notes pour ces zones
  pool
    .query(
      `
      SELECT 
        n.boundary,
        b.name as boundary_name,
        b.admin_level,
        n.ts,
        n.open,
        n.closed,
        (n.open + n.closed) as total
      FROM pdm_note_counts_per_boundary n
      JOIN pdm_boundary b ON n.boundary = b.osm_id OR n.boundary = -b.osm_id
      WHERE n.boundary = ANY($1::bigint[]) OR n.boundary = ANY(ARRAY(SELECT -x FROM unnest($1::bigint[]) AS x))
      ORDER BY n.boundary, n.ts ASC
    `,
      [boundaryIds],
    )
    .then((result) => {
      // Grouper les résultats par boundary
      const dataByBoundary = {};
      result.rows.forEach((r) => {
        const boundaryId = Math.abs(parseInt(r.boundary));
        if (!dataByBoundary[boundaryId]) {
          dataByBoundary[boundaryId] = {
            boundary: boundaryId,
            name: r.boundary_name,
            admin_level: r.admin_level,
            data: [],
          };
        }
        dataByBoundary[boundaryId].data.push({
          t: r.ts,
          open: parseInt(r.open) || 0,
          closed: parseInt(r.closed) || 0,
          total: parseInt(r.total) || 0,
        });
      });

      res.json({
        boundaries: Object.values(dataByBoundary),
      });
    })
    .catch((err) => {
      console.error("Error fetching notes by boundaries:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API endpoint to list available boundaries with note counts
app.get("/api/notes-france/boundaries/list", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const adminLevel = req.query.admin_level ? parseInt(req.query.admin_level) : null;

  pool
    .query(
      `
      SELECT DISTINCT
        b.osm_id as boundary,
        b.name,
        b.admin_level,
        COUNT(DISTINCT n.ts) as data_points
      FROM pdm_boundary b
      INNER JOIN pdm_note_counts_per_boundary n 
        ON (n.boundary = b.osm_id OR n.boundary = -b.osm_id)
      WHERE b.admin_level IN (4, 6, 8)
        ${adminLevel ? 'AND b.admin_level = $1' : ''}
      GROUP BY b.osm_id, b.name, b.admin_level
      ORDER BY b.admin_level, b.name
    `,
      adminLevel ? [adminLevel] : [],
    )
    .then((result) => {
      res.json({
        boundaries: result.rows.map((r) => ({
          boundary: parseInt(r.boundary),
          name: r.name,
          admin_level: parseInt(r.admin_level),
          data_points: parseInt(r.data_points) || 0,
        })),
      });
    })
    .catch((err) => {
      console.error("Error fetching boundaries list:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// OSM Plein Air - Hiking routes monitoring page
app.get("/osm-plein-air", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  // Get all hiking routes (type=route and route=hiking) and total count
  Promise.all([
    pool.query(
      `
      SELECT 
        osm_id,
        name,
        tags->>'ref' as ref,
        tags->>'network' as network,
        tags->>'operator' as operator,
        tags->>'distance' as distance,
        tags->>'ascent' as ascent,
        tags->>'descent' as descent,
        tags->>'duration' as duration
      FROM pdm_relation_hiking
      ORDER BY name, osm_id
      LIMIT 1000
    `,
    ),
    pool.query(
      `
      SELECT COUNT(*) as total
      FROM pdm_relation_hiking
    `,
    ),
  ])
    .then(([routesResult, countResult]) => {
      res.render("pages/osm_plein_air", {
        CONFIG,
        routes: routesResult.rows.map((r) => ({
          id: parseInt(r.osm_id),
          name: r.name,
          ref: r.ref,
          network: r.network,
          operator: r.operator,
          distance: r.distance,
          ascent: r.ascent,
          descent: r.descent,
          duration: r.duration,
        })),
        totalCount: parseInt(countResult.rows[0].total) || 0,
        bbox: {
          west: 5.0,
          south: 44.0,
          east: 7.5,
          north: 46.5,
        },
      });
    })
    .catch((err) => {
      console.error("Error fetching hiking routes:", err);
      // If table doesn't exist yet, render empty page
      res.render("pages/osm_plein_air", {
        CONFIG,
        routes: [],
        totalCount: 0,
        bbox: {
          west: 5.0,
          south: 44.0,
          east: 7.5,
          north: 46.5,
        },
      });
    });
});

// API endpoint for hiking route member history
app.get("/api/hiking-route/:relation_id/members", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const relationId = parseInt(req.params.relation_id);
  if (isNaN(relationId)) {
    return res.status(400).json({ error: "Invalid relation ID" });
  }

  pool
    .query(
      `
      SELECT 
        ts,
        member_count,
        changeset_id,
        username,
        userid
      FROM pdm_relation_hiking_members
      WHERE relation_id = $1
      ORDER BY ts ASC
    `,
      [relationId],
    )
    .then((result) => {
      res.json({
        relation_id: relationId,
        history: result.rows.map((r) => ({
          ts: r.ts,
          member_count: parseInt(r.member_count) || 0,
          changeset_id: r.changeset_id ? parseInt(r.changeset_id) : null,
          username: r.username,
          userid: r.userid ? parseInt(r.userid) : null,
        })),
      });
    })
    .catch((err) => {
      console.error("Error fetching route members history:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// API endpoint for hiking route continuity breaks
app.get("/api/hiking-route/:relation_id/breaks", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  const relationId = parseInt(req.params.relation_id);
  if (isNaN(relationId)) {
    return res.status(400).json({ error: "Invalid relation ID" });
  }

  pool
    .query(
      `
      WITH member_history AS (
        SELECT 
          ts,
          member_count,
          changeset_id,
          username,
          userid,
          LAG(member_count) OVER (ORDER BY ts) as prev_count
        FROM pdm_relation_hiking_members
        WHERE relation_id = $1
        ORDER BY ts ASC
      )
      SELECT 
        ts,
        member_count,
        prev_count,
        (member_count - prev_count) as change,
        changeset_id,
        username,
        userid
      FROM member_history
      WHERE prev_count IS NOT NULL 
        AND member_count < prev_count
        AND (member_count - prev_count) < -1
      ORDER BY ts DESC
    `,
      [relationId],
    )
    .then((result) => {
      res.json({
        relation_id: relationId,
        breaks: result.rows.map((r) => ({
          ts: r.ts,
          member_count: parseInt(r.member_count) || 0,
          prev_count: parseInt(r.prev_count) || 0,
          change: parseInt(r.change) || 0,
          changeset_id: r.changeset_id ? parseInt(r.changeset_id) : null,
          username: r.username,
          userid: r.userid ? parseInt(r.userid) : null,
        })),
      });
    })
    .catch((err) => {
      console.error("Error fetching route breaks:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// Quality completion statistics endpoint
app.get("/projects/:id/quality", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  const p = projects[req.params.id];
  
  if (!p.quality || !p.quality.required_tags || !Array.isArray(p.quality.required_tags) || p.quality.required_tags.length === 0) {
    return res.status(404).json({ error: "Quality completion not enabled for this project" });
  }

  pool
    .query(
      `
      SELECT 
        ts,
        total_objects,
        avg_completion,
        fully_complete,
        partially_complete,
        incomplete
      FROM pdm_quality_stats
      WHERE project = $1
      ORDER BY ts ASC
    `,
      [req.params.id],
    )
    .then((results) => {
      if (results.rows.length === 0) {
        return res.json({
          project: req.params.id,
          required_tags: p.quality.required_tags,
          stats: null,
          message: "No quality statistics available yet",
        });
      }

      res.json({
        project: req.params.id,
        required_tags: p.quality.required_tags,
        stats: results.rows.map((r) => ({
          ts: r.ts,
          total_objects: parseInt(r.total_objects),
          avg_completion: parseFloat(r.avg_completion),
          fully_complete: parseInt(r.fully_complete),
          partially_complete: parseInt(r.partially_complete),
          incomplete: parseInt(r.incomplete),
        })),
        current: {
          avg_completion: parseFloat(results.rows[results.rows.length - 1].avg_completion),
          fully_complete: parseInt(results.rows[results.rows.length - 1].fully_complete),
          partially_complete: parseInt(results.rows[results.rows.length - 1].partially_complete),
          incomplete: parseInt(results.rows[results.rows.length - 1].incomplete),
          total_objects: parseInt(results.rows[results.rows.length - 1].total_objects),
        },
      });
    })
    .catch((err) => {
      console.error("Error fetching quality stats:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// Zone podiums endpoint (top cities by quality and progress)
app.get("/projects/:id/zones-podiums", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.status(503).json({ error: "Service unavailable" });
  }

  if (!req.params.id || !projects[req.params.id]) {
    return res.status(404).json({ error: "Project not found" });
  }

  const p = projects[req.params.id];
  const projectId = req.params.id;

  Promise.all([
    // Top 10 cities by quality (average completion percentage)
    p.quality && p.quality.required_tags
      ? pool
          .query(
            `
            WITH latest_quality AS (
              SELECT 
                qc.osmid,
                qc.completion_percentage,
                fb.boundary
              FROM pdm_quality_completion qc
              INNER JOIN (
                SELECT osmid, MAX(ts) as max_ts
                FROM pdm_quality_completion
                WHERE project = $1
                GROUP BY osmid
              ) latest ON qc.osmid = latest.osmid AND qc.ts = latest.max_ts
              INNER JOIN pdm_features_boundary fb ON fb.project = $1 
                AND fb.osmid::text = qc.osmid
                AND (fb.end_ts IS NULL OR fb.end_ts > NOW())
            ),
            boundary_quality AS (
              SELECT 
                boundary,
                AVG(completion_percentage)::NUMERIC(5,2) as avg_completion,
                COUNT(*) as object_count
              FROM latest_quality
              WHERE boundary IS NOT NULL
              GROUP BY boundary
              HAVING COUNT(*) >= 5
            )
            SELECT 
              b.osm_id,
              b.name,
              bq.avg_completion,
              bq.object_count
            FROM boundary_quality bq
            INNER JOIN pdm_boundary b ON b.osm_id = bq.boundary
            WHERE b.admin_level IN (8, 9, 10)
            ORDER BY bq.avg_completion DESC, bq.object_count DESC
            LIMIT 10
          `,
            [projectId],
          )
          .then((results) =>
            results.rows.map((r) => ({
            boundary_id: Math.abs(parseInt(r.osm_id)),
            name: r.name,
            avg_completion: parseFloat(r.avg_completion),
            object_count: parseInt(r.object_count),
            })),
          )
      : Promise.resolve([]),

    // Top 10 cities by progress (objects added in last 30 days)
    pool
      .query(
        `
        WITH current_count AS (
          SELECT boundary, amount, ts
          FROM pdm_feature_counts_per_boundary
          WHERE project = $1
          ORDER BY ts DESC
          LIMIT 1
        ),
        count_30_days_ago AS (
          SELECT fcpb.boundary, fcpb.amount, fcpb.ts
          FROM pdm_feature_counts_per_boundary fcpb
          WHERE fcpb.project = $1
            AND fcpb.ts <= (SELECT ts - INTERVAL '30 days' FROM current_count)
            AND fcpb.boundary IN (
              SELECT DISTINCT boundary 
              FROM pdm_feature_counts_per_boundary 
              WHERE project = $1 AND ts = (SELECT ts FROM current_count)
            )
          ORDER BY fcpb.ts DESC
        ),
        boundary_progress AS (
          SELECT 
            COALESCE(cc.boundary, c30.boundary) as boundary,
            COALESCE(cc.amount, 0) as current_amount,
            COALESCE(c30.amount, 0) as past_amount,
            (COALESCE(cc.amount, 0) - COALESCE(c30.amount, 0)) as added
          FROM (
            SELECT DISTINCT boundary, amount
            FROM pdm_feature_counts_per_boundary
            WHERE project = $1
              AND ts = (SELECT ts FROM current_count)
          ) cc
          FULL OUTER JOIN (
            SELECT DISTINCT ON (boundary) boundary, amount
            FROM count_30_days_ago
            ORDER BY boundary, ts DESC
          ) c30 ON cc.boundary = c30.boundary
        )
        SELECT 
          b.osm_id,
          COALESCE(b.name, 'Sans nom') as name,
          bp.added,
          bp.current_amount,
          bp.past_amount
        FROM boundary_progress bp
        INNER JOIN pdm_boundary b ON (b.osm_id = bp.boundary OR b.osm_id = -bp.boundary)
        WHERE b.admin_level IN (8, 9, 10)
          AND bp.added > 0
        ORDER BY bp.added DESC, bp.current_amount DESC
        LIMIT 10
      `,
        [projectId],
      )
      .then((results) =>
        results.rows.map((r) => ({
          boundary_id: Math.abs(parseInt(r.osm_id)),
          name: r.name,
          added: parseInt(r.added),
          current_amount: parseInt(r.current_amount),
          past_amount: parseInt(r.past_amount),
        })),
      ),
  ])
    .then(([qualityPodium, progressPodium]) => {
      res.json({
        quality: qualityPodium,
        progress: progressPodium,
      });
    })
    .catch((err) => {
      console.error("Error fetching zone podiums:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

// User contributions
app.post("/projects/:id/contribute/:userid", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  // Check project is active
  const p = foldProjects(projects);
  if (
    !req.params.id ||
    !projects[req.params.id] ||
    p.current.length < 1 ||
    p.current.find((p) => p.id === req.params.id) === undefined
  ) {
    return res.redirect("/error/400");
  }

  // Check userid seem valid
  if (
    !req.params.userid ||
    !/^\d+$/.test(req.params.userid) ||
    typeof req.query.username !== "string" ||
    req.query.username.trim().length === 0
  ) {
    return res.redirect("/error/400");
  }

  // Check type of contribution
  if (
    !req.query.type ||
    !["add", "edit", "delete", "note"].includes(req.query.type)
  ) {
    return res.redirect("/error/400");
  }

  // Update user name in DB
  pool
    .query(
      "INSERT INTO pdm_user_names(userid, username) VALUES ($1, $2) ON CONFLICT (userid) DO UPDATE SET username = EXCLUDED.username",
      [req.params.userid, req.query.username],
    )
    .then((r1) => {
      // Get badges before edit
      pool
        .query("SELECT * FROM pdm_get_badges($1, $2)", [
          req.params.id,
          req.params.userid,
        ])
        .then((r2) => {
          const badgesBefore = r2.rows;

          // Insert contribution (will be deleted and re-inserted at next project update)
          pool
            .query(
              "WITH points AS (SELECT pts FROM pdm_projects_points WHERE project=$1 AND contrib=$3) INSERT INTO pdm_user_contribs(project, userid, ts, contribution, verified, points) VALUES (SELECT $1, $2, current_timestamp, $3, false, pts FROM points)",
              [req.params.id, req.params.userid, req.query.type],
            )
            .then((r3) => {
              // Get badges after contribution
              pool
                .query("SELECT * FROM pdm_get_badges($1, $2)", [
                  req.params.id,
                  req.params.userid,
                ])
                .then((r4) => {
                  const badgesAfter = r4.rows;
                  const badgesForDisplay = badgesAfter.filter((b) => {
                    const badgeInBefore = badgesBefore.find(
                      (b2) => b.id === b2.id,
                    );
                    return (
                      !badgeInBefore ||
                      !b.acquired ||
                      badgeInBefore.acquired !== b.acquired
                    );
                  });
                  res.send({ badges: badgesForDisplay });
                })
                .catch((e) => {
                  res.redirect("/error/500");
                });
            })
            .catch((e) => {
              res.redirect("/error/500");
            });
        })
        .catch((e) => {
          res.redirect("/error/500");
        });
    })
    .catch((e) => {
      res.redirect("/error/500");
    });
});

// Add OSM feature to compare exclusion list
app.post("/projects/:id/ignore/:osmtype/:osmid", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  // Check project exists
  if (!req.params.id || !projects[req.params.id]) {
    return res.redirect("/error/404");
  }
  // Check OSM ID
  if (
    !req.params.osmtype ||
    !["node", "way", "relation"].includes(req.params.osmtype) ||
    !req.params.osmid ||
    !/^\d+$/.test(req.params.osmid)
  ) {
    return res.redirect("/error/400");
  }

  pool
    .query(
      "INSERT INTO pdm_compare_exclusions(project, osm_id, userid) VALUES ($1, $2, $3) ON CONFLICT (project, osm_id) DO UPDATE SET ts = current_timestamp, userid = $3",
      [
        req.params.id,
        req.params.osmtype + "/" + req.params.osmid,
        req.query.user_id,
      ],
    )
    .then(() => {
      res.send();
    })
    .catch((e) => {
      res.redirect("/error/500");
    });
});

// User page
app.get("/users/:name", (req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }

  if (!req.params.name) {
    return res.redirect("/error/404");
  }

  // Find user in database
  pool
    .query(`SELECT userid FROM pdm_user_names WHERE username = $1`, [
      req.params.name,
    ])
    .then((res1) => {
      if (res1.rows.length === 1) {
        const userid = res1.rows[0].userid;

        // Fetch badges
        const sql = Object.entries(projects)
          .map(
            (e) =>
              `SELECT '${e[0]}' AS project, * FROM pdm_get_badges('${e[0]}', $1)`,
          )
          .concat([
            `SELECT 'meta' AS project, * FROM pdm_get_badges('meta', $1)`,
          ])
          .join(" UNION ALL ");

        pool
          .query(sql, [userid])
          .then((res2) => {
            res.render("pages/user", {
              CONFIG,
              username: req.params.name,
              userid,
              badges: getBadgesDetails(projects, res2.rows),
            });
          })
          .catch((e) => {
            res.redirect("/error/500");
          });
      } else {
        res.redirect("/error/404");
      }
    })
    .catch((e) => {
      res.redirect("/error/500");
    });
});

// Documentation
["README.md", "DEVELOP.md", "LICENSE.txt"].forEach((file) => {
  app.get(`/${file}`, (req, res) => {
    res.sendFile(path.join(__dirname, "..", file));
  });
});

// Images
app.use("/images", express.static(__dirname + "/images"));
app.use("/website/images", express.static(__dirname + "/images"));

// Static content
fs.readdirSync(path.join(__dirname, "static")).forEach((file) => {
  app.get(`/${file}`, (req, res) => {
    if (file === "manifest.webmanifest") {
      res.contentType("application/manifest+json");
    }
    res.sendFile(path.join(__dirname, "static", file));
  });
});

// Libraries
const authorized = {
  bootstrap: { "bootstrap.css": "dist/css/bootstrap.min.css" },
  "bootstrap.native": { "bootstrap.js": "dist/bootstrap-native.min.js" },
  "chart.js": {
    "chart.js": "dist/Chart.bundle.min.js",
    "chart.css": "dist/Chart.min.css",
  },
  "maplibre-gl": {
    "maplibre-gl.js": "dist/maplibre-gl.js",
    "maplibre-gl.css": "dist/maplibre-gl.css",
  },
  "mapillary-js": {
    "mapillary.js": "dist/mapillary.js",
    "mapillary.css": "dist/mapillary.css",
  },
  "osm-auth": { "osmauth.js": "dist/osm-auth.iife.js" },
  "osm-request": { "osmrequest.js": "dist/OsmRequest.js" },
  pic4carto: { "pic4carto.js": "dist/P4C.min.js" },
  "swiped-events": { "swiped-events.js": "dist/swiped-events.min.js" },
  wordcloud: { "wordcloud.js": "src/wordcloud2.js" },
};

app.get("/lib/:modname/:file", (req, res) => {
  if (!req.params.modname || !req.params.file) {
    return res.status(400).send("Missing parameters");
  } else if (
    !authorized[req.params.modname] ||
    !authorized[req.params.modname][req.params.file]
  ) {
    return res.status(404).send("File not found");
  }

  const options = {
    root: path.join(__dirname, "../node_modules"),
    dotfiles: "deny",
    headers: {
      "x-timestamp": Date.now(),
      "x-sent": true,
    },
  };

  const fileName = `${req.params.modname}/${authorized[req.params.modname][req.params.file]}`;
  res.sendFile(fileName, options, (err) => {
    if (err) {
      res.status(err.status ? err.status : 500).end();
    }
  });
});

app.use(
  "/lib/fontawesome",
  express.static(
    path.join(__dirname, "../node_modules/@fortawesome/fontawesome-free"),
  ),
);

// 404
app.use((req, res) => {
  if (CONFIG.MAINTENANCE_MODE === true) {
    return res.redirect("/");
  }
  res.redirect("/error/404");
});

// Start
pool
  .query("SELECT version()")
  .then(() => {
    app.listen(port, () => {
      console.log("API started on port: " + port);
    });
  })
  .catch((e) => {
    console.error("Can't connect to database :", e.message);
  });
