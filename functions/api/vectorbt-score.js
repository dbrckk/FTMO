export async function onRequestPost(context) {
  try {
    const env = context.env || {};
    const vectorbtUrl = env.VECTORBT_SERVICE_URL || "";

    if (!vectorbtUrl) {
      return json({
        ok: false,
        error: "Missing VECTORBT_SERVICE_URL"
      }, 500);
    }

    const payload = await context.request.json();

    const response = await fetch(`${vectorbtUrl.replace(/\/$/, "")}/backtest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    return new Response(text, {
      status: response.status,
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    });
  } catch {
    return json({
      ok: false,
      error: "VectorBT proxy failed"
    }, 500);
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
