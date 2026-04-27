import {
  ensureNewsTables,
  insertNewsEvent,
  listNewsEvents,
  evaluateNewsRisk
} from "../_shared/news-filter.js";

const MODEL_VERSION = "news-events-v1";

export async function onRequestGet(context) {
  return handleNewsEvents(context);
}

export async function onRequestPost(context) {
  return handleNewsEvents(context);
}

async function handleNewsEvents(context) {
  try {
    const env = context.env || {};
    const db = env.DB;

    if (!db) {
      return json({
        ok: false,
        source: "news-events",
        version: MODEL_VERSION,
        error: "Missing DB binding"
      }, 500);
    }

    if (!isAuthorized(context.request, env.SYNC_SECRET || "")) {
      return json({
        ok: false,
        source: "news-events",
        version: MODEL_VERSION,
        error: "Unauthorized"
      }, 401);
    }

    await ensureNewsTables(db);

    const url = new URL(context.request.url);
    const body = context.request.method === "POST" ? await safeJson(context.request) : {};

    if (context.request.method === "POST") {
      const events = Array.isArray(body.events)
        ? body.events
        : Array.isArray(body)
          ? body
          : [body];

      const inserted = [];

      for (const event of events) {
        inserted.push(await insertNewsEvent(db, event));
      }

      return json({
        ok: true,
        source: "news-events",
        version: MODEL_VERSION,
        inserted: inserted.length,
        events: inserted
      });
    }

    const pair = String(url.searchParams.get("pair") || "").toUpperCase();
    const timeframe = String(url.searchParams.get("timeframe") || "M15").toUpperCase();

    const events = await listNewsEvents(db, {
      pastHours: Number(url.searchParams.get("pastHours") || 12),
      futureHours: Number(url.searchParams.get("futureHours") || 72)
    });

    let risk = null;

    if (pair) {
      risk = await evaluateNewsRisk(db, {
        pair,
        timeframe,
        signal: "BUY",
        direction: "buy"
      }, {
        env
      });
    }

    return json({
      ok: true,
      source: "news-events",
      version: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      pair: pair || null,
      timeframe,
      count: events.length,
      risk,
      events
    });
  } catch (error) {
    return json({
      ok: false,
      source: "news-events",
      version: MODEL_VERSION,
      error: String(error?.message || error || "news-events-error")
    }, 500);
  }
}

function isAuthorized(request, secret) {
  if (!secret) return true;

  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  return token === secret || bearer === secret;
}

async function safeJson(request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("application/json")) {
      return {};
    }

    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store"
    }
  });
}
