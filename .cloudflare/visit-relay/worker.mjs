const siteOrigin = "https://minjookim-finance.github.io";

function reply(status) {
  return new Response(null, {
    status,
    headers: {
      "Access-Control-Allow-Origin": siteOrigin,
      "Cache-Control": "no-store",
      "Allow": "POST",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/visit" || url.search) return reply(404);
    if (request.method !== "POST") return reply(405);
    if (request.headers.get("Origin") !== siteOrigin) return reply(403);
    if (!env.NTFY_TOPIC || !env.VISIT_LIMITER) return reply(503);

    let stage = "rate-limit check";
    try {
      const key = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.VISIT_LIMITER.limit({ key });
      if (!success) return reply(429);

      stage = "ntfy publish";
      const published = await fetch("https://ntfy.sh/", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: env.NTFY_TOPIC,
          title: "Website visit",
          message: "Someone visited your academic website.",
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (published.ok) return reply(204);
      console.warn("ntfy returned HTTP", published.status);
      return reply(published.status === 429 ? 429 : 502);
    } catch (error) {
      console.warn("Visit relay failed during", stage, error.name);
      return reply(502);
    }
  },
};
