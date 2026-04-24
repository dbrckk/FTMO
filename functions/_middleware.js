export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  const isWriteMethod =
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH";

  const publicApiPaths = [
    "/api/import-market-csv",
    "/api/sync-market",
    "/api/market-data",
    "/api/ml-score",
    "/api/vectorbt-score",
    "/api/ai-decision",
    "/api/exit-engine",
    "/api/correlation-matrix",
    "/api/portfolio-risk",
    "/api/archive-stats",
    "/api/paper-trades"
  ];

  const isKnownApi = publicApiPaths.some((path) => url.pathname === path);

  if (isWriteMethod && isKnownApi) {
    const hasSupportedContentType =
      contentType.includes("application/json") ||
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType === "";

    if (!hasSupportedContentType) {
      return json({
        ok: false,
        error: "Unsupported Content-Type"
      }, 415);
    }
  }

  return context.next();
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
