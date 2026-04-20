export async function onRequest(context) {
  const { request, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  if (pathname.startsWith("/api/")) {
    if (!["GET", "POST", "OPTIONS"].includes(method)) {
      return json(
        {
          ok: false,
          error: "Method not allowed"
        },
        405
      );
    }

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildHeaders()
      });
    }

    const contentType = request.headers.get("content-type") || "";
    const needsJsonBody = method === "POST";

    if (needsJsonBody && !contentType.includes("application/json")) {
      return json(
        {
          ok: false,
          error: "Content-Type must be application/json"
        },
        415
      );
    }

    const response = await next();
    const newHeaders = new Headers(response.headers);

    for (const [key, value] of Object.entries(buildHeaders())) {
      newHeaders.set(key, value);
    }

    newHeaders.set("X-App-Route", pathname);
    newHeaders.set("X-App-Method", method);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  }

  return next();
}

function buildHeaders() {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...buildHeaders(),
      "Content-Type": "application/json; charset=UTF-8"
    }
  });
}
