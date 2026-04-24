const path = require("path");
const crypto = require("crypto");
const express = require("express");
const dotenv = require("dotenv");
const { Pool } = require("pg");
const OpenAI = require("openai");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;
const defaultModel = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const pageSize = 20;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is missing. Add it to .env.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.PG_SSL_DISABLE === "true" ? false : { rejectUnauthorized: false }
});

const DEFAULT_PROMPTS = {
  ideaPrompt:
    "You read a spoken text fragment and return only the core idea in one short sentence, in Spanish.",
  blockSummaryPrompt:
    "You receive 10 consecutive text fragments from a book note session. Write a short Spanish summary that keeps narrative continuity and highlights the key ideas."
};

const recentTextsCache = new Map();
const fragmentCountCache = new Map();
const summaryJobs = new Set();

const initPromise = initDatabase().then(initRuntimeCaches);

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fragments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      idea TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_fragments_project_created_at
      ON fragments(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS block_summaries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      block_number INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, block_number)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(
    `
    INSERT INTO settings(key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO NOTHING
  `,
    ["selectedModel", defaultModel]
  );
  await pool.query(
    `
    INSERT INTO settings(key, value)
    VALUES ($1, $2)
    ON CONFLICT (key) DO NOTHING
  `,
    ["prompts", JSON.stringify(DEFAULT_PROMPTS)]
  );
}

async function initRuntimeCaches() {
  const countResult = await pool.query(`
    SELECT project_id, COUNT(*)::int AS count
    FROM fragments
    GROUP BY project_id
  `);
  for (const row of countResult.rows) {
    fragmentCountCache.set(row.project_id, row.count);
  }

  const recentResult = await pool.query(`
    SELECT project_id, text
    FROM (
      SELECT
        project_id,
        text,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
      FROM fragments
    ) recent
    WHERE rn <= 3
    ORDER BY project_id, rn ASC
  `);

  for (const row of recentResult.rows) {
    const list = recentTextsCache.get(row.project_id) || [];
    list.push(row.text);
    recentTextsCache.set(row.project_id, list);
  }
}

async function getSettings() {
  const result = await pool.query("SELECT key, value FROM settings");
  const map = Object.fromEntries(result.rows.map((row) => [row.key, row.value]));

  let prompts = DEFAULT_PROMPTS;
  try {
    prompts = { ...DEFAULT_PROMPTS, ...(JSON.parse(map.prompts || "{}") || {}) };
  } catch (_error) {
    prompts = DEFAULT_PROMPTS;
  }

  return {
    selectedModel: map.selectedModel || defaultModel,
    prompts
  };
}

function updateRecentTextsCache(projectId, text) {
  const items = recentTextsCache.get(projectId) || [];
  items.unshift(text);
  if (items.length > 3) items.length = 3;
  recentTextsCache.set(projectId, items);
}

function getRecentContext(projectId) {
  const cached = recentTextsCache.get(projectId) || [];
  return [...cached].reverse();
}

async function rebuildProjectCaches(projectId) {
  const countResult = await pool.query(
    "SELECT COUNT(*)::int AS count FROM fragments WHERE project_id = $1",
    [projectId]
  );
  fragmentCountCache.set(projectId, countResult.rows[0].count);

  const recentResult = await pool.query(
    `
    SELECT text
    FROM fragments
    WHERE project_id = $1
    ORDER BY created_at DESC
    LIMIT 3
  `,
    [projectId]
  );
  const items = recentResult.rows.map((row) => row.text);
  recentTextsCache.set(projectId, items);
}

async function ensureBlockSummaryGenerated(projectId, blockNumber, projectName, settings) {
  const jobId = `${projectId}:${blockNumber}`;
  if (summaryJobs.has(jobId)) return;
  summaryJobs.add(jobId);

  try {
    if (!openai) return;

    const existing = await pool.query(
      "SELECT id FROM block_summaries WHERE project_id = $1 AND block_number = $2",
      [projectId, blockNumber]
    );
    if (existing.rowCount) return;

    const offset = (blockNumber - 1) * 10;
    const fragmentsResult = await pool.query(
      `
      SELECT text
      FROM fragments
      WHERE project_id = $1
      ORDER BY created_at ASC
      OFFSET $2 LIMIT 10
    `,
      [projectId, offset]
    );

    if (fragmentsResult.rowCount < 10) return;

    const fragmentsText = fragmentsResult.rows
      .map((row, index) => `${index + 1}. ${row.text}`)
      .join("\n");

    const response = await openai.responses.create({
      model: settings.selectedModel || defaultModel,
      input: [
        {
          role: "system",
          content: settings.prompts.blockSummaryPrompt || DEFAULT_PROMPTS.blockSummaryPrompt
        },
        {
          role: "user",
          content: `Project: ${projectName}\nBlock number: ${blockNumber}\nFragments:\n${fragmentsText}`
        }
      ],
      max_output_tokens: 180
    });

    const summary = (response.output_text || "").trim() || "Resumen no disponible.";

    await pool.query(
      `
      INSERT INTO block_summaries (id, project_id, block_number, summary)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (project_id, block_number)
      DO UPDATE SET summary = EXCLUDED.summary
    `,
      [crypto.randomUUID(), projectId, blockNumber, summary]
    );
  } catch (error) {
    console.error("Block summary generation error:", error);
  } finally {
    summaryJobs.delete(jobId);
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(async (_req, res, next) => {
  try {
    await initPromise;
    next();
  } catch (error) {
    console.error("Database init middleware error:", error);
    res.status(500).json({ error: "Database initialization failed." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasOpenAIKey: Boolean(apiKey), hasDatabaseUrl: Boolean(databaseUrl) });
});

app.get("/api/projects", async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.created_at AS "createdAt",
        COUNT(f.id)::int AS "fragmentCount"
      FROM projects p
      LEFT JOIN fragments f ON f.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);
    res.json({ projects: result.rows });
  } catch (error) {
    console.error("Projects list error:", error);
    res.status(500).json({ error: "Failed to load projects." });
  }
});

app.post("/api/projects", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Project name is required." });

    const id = crypto.randomUUID();
    const insert = await pool.query(
      `
      INSERT INTO projects (id, name)
      VALUES ($1, $2)
      RETURNING id, name, created_at AS "createdAt"
    `,
      [id, name]
    );

    fragmentCountCache.set(id, 0);
    recentTextsCache.set(id, []);

    res.status(201).json({
      project: {
        ...insert.rows[0],
        fragmentCount: 0
      }
    });
  } catch (error) {
    console.error("Create project error:", error);
    res.status(500).json({ error: "Failed to create project." });
  }
});

app.get("/api/projects/:projectId/fragments", async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const project = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!project.rowCount) return res.status(404).json({ error: "Project not found." });

    const countResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM fragments WHERE project_id = $1",
      [projectId]
    );
    const total = countResult.rows[0].count;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    let page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    if (page > totalPages) page = totalPages;
    const offset = (page - 1) * pageSize;

    const rows = await pool.query(
      `
      SELECT id, idea, status, created_at AS "createdAt"
      FROM fragments
      WHERE project_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `,
      [projectId, pageSize, offset]
    );

    res.json({
      fragments: rows.rows,
      page,
      pageSize,
      total,
      totalPages
    });
  } catch (error) {
    console.error("Fragments list error:", error);
    res.status(500).json({ error: "Failed to load fragments." });
  }
});

app.get("/api/projects/:projectId/block-summaries", async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || "20"), 10) || 20));

    const rows = await pool.query(
      `
      SELECT
        id,
        block_number AS "blockNumber",
        summary,
        created_at AS "createdAt"
      FROM block_summaries
      WHERE project_id = $1
      ORDER BY block_number DESC
      LIMIT $2
    `,
      [projectId, limit]
    );

    res.json({ summaries: rows.rows });
  } catch (error) {
    console.error("Block summaries list error:", error);
    res.status(500).json({ error: "Failed to load block summaries." });
  }
});

app.get("/api/fragments/:fragmentId/text", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, text FROM fragments WHERE id = $1", [
      req.params.fragmentId
    ]);
    if (!result.rowCount) return res.status(404).json({ error: "Fragment not found." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Fragment text error:", error);
    res.status(500).json({ error: "Failed to load fragment text." });
  }
});

app.delete("/api/fragments/:fragmentId", async (req, res) => {
  try {
    const deleted = await pool.query(
      "DELETE FROM fragments WHERE id = $1 RETURNING id, project_id AS \"projectId\"",
      [req.params.fragmentId]
    );
    if (!deleted.rowCount) return res.status(404).json({ error: "Fragment not found." });

    const projectId = deleted.rows[0].projectId;
    await pool.query("DELETE FROM block_summaries WHERE project_id = $1", [projectId]);
    await rebuildProjectCaches(projectId);

    res.status(204).end();
  } catch (error) {
    console.error("Delete fragment error:", error);
    res.status(500).json({ error: "Failed to delete fragment." });
  }
});

app.delete("/api/projects/:projectId/fragments/last", async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const last = await pool.query(
      `
      DELETE FROM fragments
      WHERE id IN (
        SELECT id
        FROM fragments
        WHERE project_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      )
      RETURNING id
    `,
      [projectId]
    );

    if (!last.rowCount) return res.status(404).json({ error: "No fragments to delete." });

    await pool.query("DELETE FROM block_summaries WHERE project_id = $1", [projectId]);
    await rebuildProjectCaches(projectId);

    res.json({ deletedId: last.rows[0].id });
  } catch (error) {
    console.error("Delete last fragment error:", error);
    res.status(500).json({ error: "Failed to delete last fragment." });
  }
});

app.post("/api/projects/:projectId/fragments/analyze", async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Missing text to analyze." });

    const project = await pool.query("SELECT id, name FROM projects WHERE id = $1", [projectId]);
    if (!project.rowCount) return res.status(404).json({ error: "Project not found." });

    if (!openai) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing. Add it to .env and restart the server."
      });
    }

    const settings = await getSettings();
    const previousContext = getRecentContext(projectId);
    const contextText = previousContext.length
      ? previousContext.map((item, index) => `- Context ${index + 1}: ${item}`).join("\n")
      : "- Context: none";

    const response = await openai.responses.create({
      model: settings.selectedModel || defaultModel,
      input: [
        {
          role: "system",
          content: settings.prompts.ideaPrompt || DEFAULT_PROMPTS.ideaPrompt
        },
        {
          role: "user",
          content: `Project: ${project.rows[0].name}\nPrevious context:\n${contextText}\nCurrent fragment:\n${text}`
        }
      ],
      max_output_tokens: 100
    });

    const idea = (response.output_text || "").trim() || "Sin idea generada.";
    const id = crypto.randomUUID();
    const insert = await pool.query(
      `
      INSERT INTO fragments (id, project_id, text, idea, status)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, idea, status, created_at AS "createdAt"
    `,
      [id, projectId, text, idea, "done"]
    );

    updateRecentTextsCache(projectId, text);
    const newCount = (fragmentCountCache.get(projectId) || 0) + 1;
    fragmentCountCache.set(projectId, newCount);

    if (newCount % 10 === 0) {
      const blockNumber = newCount / 10;
      void ensureBlockSummaryGenerated(projectId, blockNumber, project.rows[0].name, settings);
    }

    res.status(201).json({ fragment: insert.rows[0] });
  } catch (error) {
    console.error("Analyze+save error:", error);
    res.status(500).json({ error: "Failed to analyze fragment." });
  }
});

app.get("/api/settings", async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (error) {
    console.error("Load settings error:", error);
    res.status(500).json({ error: "Failed to load settings." });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const selectedModel = String(req.body?.selectedModel || "").trim();
    const prompts = req.body?.prompts;
    const safePrompts = {
      ...DEFAULT_PROMPTS,
      ...(prompts && typeof prompts === "object" ? prompts : {})
    };

    if (!selectedModel) return res.status(400).json({ error: "selectedModel is required." });

    await pool.query(
      `
      INSERT INTO settings(key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
      ["selectedModel", selectedModel]
    );
    await pool.query(
      `
      INSERT INTO settings(key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `,
      ["prompts", JSON.stringify(safePrompts)]
    );

    res.json(await getSettings());
  } catch (error) {
    console.error("Save settings error:", error);
    res.status(500).json({ error: "Failed to save settings." });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing. Add it to .env and restart the server."
      });
    }

    const modelsSet = new Set();
    let page = await openai.models.list();
    while (page) {
      for (const model of page.data || []) {
        if (model?.id) modelsSet.add(model.id);
      }
      if (!page.hasNextPage || !page.hasNextPage()) break;
      page = await page.getNextPage();
    }

    const models = [...modelsSet].sort((a, b) => a.localeCompare(b));
    res.json({ models });
  } catch (error) {
    console.error("Models list error:", error);
    res.status(500).json({ error: "Failed to fetch models." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (!process.env.VERCEL) {
  initPromise
    .then(() => {
      app.listen(port, () => {
        console.log(`Booky running at http://localhost:${port}`);
      });
    })
    .catch((error) => {
      console.error("Failed to initialize database:", error);
      process.exit(1);
    });
}

module.exports = app;
