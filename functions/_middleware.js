export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  const isWriteMethod = method === "POST" || method === "PUT" || method === "PATCH";
  const allowImportCsv = url.pathname === "/api/import-market-csv";

  if (isWriteMethod && !allowImportCsv) {
    const isSupported =
      contentType.includes("application/json") ||
      contentType.includes("multipart/form-data") ||
      contentType.includes("application/x-www-form-urlencoded");

    if (!isSupported) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Unsupported Content-Type"
        }),
        {
          status: 415,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        }
      );
    }
  }

  return context.next();
}
