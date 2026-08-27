import { parseJsonObjectNoDuplicateKeys } from "./strict-json.ts";

type SecretKeyBundle = Record<string, unknown>;

export function resolveServiceRoleKey(
  directValue: string | null | undefined,
  bundledValue: string | null | undefined,
): string {
  const direct = directValue || "";
  if (direct) return direct;
  if (!bundledValue) return "";

  try {
    const bundle = parseJsonObjectNoDuplicateKeys(bundledValue, {
      maximumBytes: 8 * 1024,
      maximumDepth: 4,
    }) as SecretKeyBundle;
    return String(bundle.default || bundle.service_role || "");
  } catch {
    return "";
  }
}

export function getServiceRoleKey(): string {
  return resolveServiceRoleKey(
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
    Deno.env.get("SUPABASE_SECRET_KEYS"),
  );
}
