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
    // Fetch completion statistics for all projects (even if statistics.count is not enabled)
    const allProjects = [...(p.current || []), ...(p.past || [])];
    const statsPromises = allProjects.map((proj) => {
      // Calculate number of objects added in the last 30 days for all projects
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
            COALESCE((SELECT amount FROM count_30_days_ago), 0) AS past_amount,
            COALESCE((SELECT ts FROM current_count), NOW()) AS current_ts,
            COALESCE((SELECT ts FROM count_30_days_ago), NOW() - INTERVAL '30 days') AS past_ts
        `,
          [proj.id],
        )
        .then((results) => {
          if (results.rows.length === 0) {
            return { id: proj.id, last30Days: null };
          }
          
          const row = results.rows[0];
          const currentAmount = parseInt(row.current_amount) || 0;
          const pastAmount = parseInt(row.past_amount) || 0;
          const last30Days = Math.max(0, currentAmount - pastAmount);
          
          // Always return stats, even if 0 (to display for all projects)
          return { 
            id: proj.id, 
            last30Days,
            currentAmount,
            pastAmount,
            currentTs: row.current_ts,
            pastTs: row.past_ts
          };
        })
        .catch(() => {
          return { id: proj.id, last30Days: null };
        });
    });

    Promise.all(statsPromises).then((stats) => {
      const statsMap = {};
      stats.forEach((s) => {
        statsMap[s.id] = s;
      });

      // Add stats to projects
      const currentProjectsWithStats = (p.current || []).map((proj) => ({
        ...proj,
        stats: statsMap[proj.id] || { last30Days: null },
      }));
      const otherProjectsWithStats = (p.past || []).map((proj) => ({
        ...proj,
        stats: statsMap[proj.id] || { last30Days: null },
      }));

      res.render(
        "pages/multi_projects",
        Object.assign({
          CONFIG,
          currentProjects: currentProjectsWithStats,
          otherProjects: otherProjectsWithStats.reverse(),
        }),
      );
    });
  }
  // No projects at all
  else {
    res.redirect("/error/500");
  }
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
    req.params.code && !isNaN(req.params.code) ? req.params.code : "400";
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

      return {
        chart: results,
        tasksSolved:
          nbTasksStart - nbTasksEnd > 0 ? nbTasksStart - nbTasksEnd : undefined,
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
            added,
            currentAmount,
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
        })),
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
          .then((mapStyle) => ({ mapStyle })),
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
      })),
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
    }

    // Derive averages and ETA once all data merged
    const contributors = toSend.nbContributors || 0;
    if (toSend.added != null && contributors > 0) {
      toSend.avgPerContributor = toSend.added / contributors;
    }
    if (toSend.remaining != null && contributors > 0) {
      toSend.remainingPerContributor = toSend.remaining / contributors;
    }
    // Choose a daily rate from available windows
    // Priority: 6 months (180 days) > 30 days > 7 days > 365 days
    const dailyRate =
      (toSend.added180d != null && toSend.added180d > 0
        ? toSend.added180d / 180
        : null) ||
      (toSend.added30d != null && toSend.added30d > 0
        ? toSend.added30d / 30
        : null) ||
      (toSend.addedWeek != null && toSend.addedWeek > 0
        ? toSend.addedWeek / 7
        : null) ||
      (toSend.added365d != null && toSend.added365d > 0
        ? toSend.added365d / 365
        : null);
    if (toSend.remaining != null && dailyRate) {
      toSend.etaDays = toSend.remaining / dailyRate;
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
    // Extract geographic zone from OSH_PBF_URL (e.g., "france" from "france-internal.osh.pbf")
    const pbfUrl = CONFIG.OSH_PBF_URL || "";
    const zoneMatch = pbfUrl.match(/([^\/]+)-internal\.osh\.pbf/);
    toSend.geographicZone = zoneMatch ? zoneMatch[1].charAt(0).toUpperCase() + zoneMatch[1].slice(1) : "France";

    res.send(toSend);
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
