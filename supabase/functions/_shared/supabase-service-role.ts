type SecretKeyBundle = Record<string, unknown>;

export function resolveServiceRoleKey(
  directValue: string | null | undefined,
  bundledValue: string | null | undefined,
): string {
  const direct = directValue || "";
  if (direct) return direct;
  if (!bundledValue) return "";

  try {
    const parsed: unknown = JSON.parse(bundledValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "";
    }

    const bundle = parsed as SecretKeyBundle;
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
