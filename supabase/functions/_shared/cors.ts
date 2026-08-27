import { SITE_ORIGIN } from "./public-origins.ts";

const DEFAULT_ALLOWED_ORIGINS = new Set(
  [SITE_ORIGIN, ...(Deno.env.get("MOCHIRII_CORS_ORIGINS") || "").split(",")]
    .map((origin) => origin.trim().replace(/\/+$/u, ""))
    .filter((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol === "https:" && url.origin === origin;
      } catch {
        return false;
      }
    }),
);

export type CorsOptions = {
  allowedHeaders?: string;
  allowedMethods?: string;
};

export const DEFAULT_ALLOWED_HEADERS =
  "authorization, x-client-info, apikey, content-type";
export const DEFAULT_ALLOWED_METHODS = "POST, OPTIONS";

export function protectedCorsHeaders(
  req: Request,
  options: CorsOptions = {},
): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(req.headers.get("origin")),
    "Access-Control-Allow-Headers": options.allowedHeaders ||
      DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": options.allowedMethods ||
      DEFAULT_ALLOWED_METHODS,
    "Vary": "Origin",
  };
}

export function protectedOptionsResponse(
  req: Request,
  options: CorsOptions = {},
): Response {
  return new Response("ok", {
    headers: protectedCorsHeaders(req, options),
  });
}

export async function withProtectedCors(
  req: Request,
  responseOrPromise: Response | Promise<Response>,
  options: CorsOptions = {},
): Promise<Response> {
  const response = await responseOrPromise;
  const headers = new Headers(response.headers);

  for (
    const [key, value] of Object.entries(protectedCorsHeaders(req, options))
  ) {
    if (key.toLowerCase() === "vary") {
      const existing = headers.get(key);
      headers.set(key, existing ? `${existing}, ${value}` : value);
    } else {
      headers.set(key, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function allowedOrigin(origin: string | null): string {
  if (!origin) return SITE_ORIGIN;
  if (DEFAULT_ALLOWED_ORIGINS.has(origin)) return origin;
  return SITE_ORIGIN;
}
