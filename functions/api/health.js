export async function onRequestGet(context) {
  return new Response(
    JSON.stringify({
      ok: true,
      service: "pages-functions-enabled"
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
