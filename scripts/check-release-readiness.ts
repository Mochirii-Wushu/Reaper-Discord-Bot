import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { WELCOME_DM_MESSAGE } from "../src/welcome.js";

type PackageManifest = {
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
};

type GatewayRelease = {
  schemaVersion: number;
  status: string;
  repository: string;
  entrypoint: string;
  toolchain: Record<string, string>;
  welcomeDmSha256: string;
  releaseRequirements: string[];
  activationBoundary: Record<string, boolean>;
};

const root = resolve(import.meta.dir, "..");
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");
const json = <T>(path: string): T => JSON.parse(read(path)) as T;
const fail = (message: string): never => {
  throw new Error(message);
};

type CiWorkflow = {
  jobs?: Record<string, Record<string, unknown>>;
};

function ciValidationRunsExactBaseline(source: string): boolean {
  let workflow: CiWorkflow;
  try {
    workflow = Bun.YAML.parse(source) as CiWorkflow;
  } catch {
    return false;
  }
  const validate = workflow.jobs?.validate;
  if (!validate || typeof validate !== "object" || Array.isArray(validate)) {
    return false;
  }
  if (
    JSON.stringify(Object.keys(validate).sort()) !==
      JSON.stringify(["env", "runs-on", "steps", "timeout-minutes"])
  ) return false;
  if (
    validate["runs-on"] !== "ubuntu-24.04" ||
    validate["timeout-minutes"] !== 15
  ) return false;
  const environment = validate.env;
  if (
    !environment || typeof environment !== "object" ||
    Array.isArray(environment) ||
    JSON.stringify(Object.keys(environment).sort()) !==
      JSON.stringify(["EXPECTED_SHA"]) ||
    (environment as Record<string, unknown>).EXPECTED_SHA !==
      "${{ github.event.pull_request.head.sha || github.sha }}"
  ) return false;
  const steps = validate.steps;
  if (!Array.isArray(steps)) return false;
  const exactBaselineSteps = steps.filter((step) =>
    step && typeof step === "object" && !Array.isArray(step) &&
    JSON.stringify(Object.keys(step).sort()) === JSON.stringify(["run"]) &&
    step.run === "bun run check"
  );
  return exactBaselineSteps.length === 1;
}

const ciSource = read(".github/workflows/ci.yml").replaceAll("\r\n", "\n");
if (!ciValidationRunsExactBaseline(ciSource)) {
  fail("CI validate job must run the exact required bun run check step.");
}
const exactCiStep = "      - run: bun run check";
if (ciSource.split(exactCiStep).length !== 2) {
  fail("CI baseline step must have one unambiguous source binding.");
}
const ciHostileMutants = [
  ciSource.replace(exactCiStep, ""),
  ciSource.replace(exactCiStep, "      - run: bun --version"),
  ciSource.replace(exactCiStep, "      - run: bun run check || true"),
  ciSource.replace(
    exactCiStep,
    "      - run: echo 'bun run check'",
  ),
  ciSource.replace(
    exactCiStep,
    `${exactCiStep}\n        if: false`,
  ),
  ciSource.replace(
    exactCiStep,
    "      - run: bun run check-disabled",
  ),
  `${
    ciSource.replace(exactCiStep, "      - run: bun --version")
  }\n  unbound-baseline:\n    runs-on: ubuntu-24.04\n    steps:\n${exactCiStep}\n`,
  ciSource.replace("  validate:\n", "  validate:\n    if: false\n"),
  ciSource.replace(
    "  validate:\n",
    "  validate:\n    if: ${{ always() }}\n",
  ),
  ciSource.replace(
    "  validate:\n",
    "  validate:\n    continue-on-error: true\n",
  ),
  ciSource.replace(
    "  validate:\n",
    "  validate:\n    continue-on-error: ${{ false }}\n",
  ),
  ciSource.replace("    timeout-minutes: 15", "    timeout-minutes: 1"),
  ciSource.replace("  validate:\n", "  validate:\n    needs: advisory\n"),
  ciSource.replace(
    "  validate:\n",
    "  validate:\n    strategy:\n      matrix:\n        runtime: [bun]\n",
  ),
];
if (ciHostileMutants.some(ciValidationRunsExactBaseline)) {
  fail("CI baseline hostile controls were not rejected.");
}

const manifest = json<PackageManifest>("package.json");
if (
  manifest.packageManager !== "bun@1.3.14" ||
  manifest.engines?.bun !== "1.3.14" ||
  manifest.engines?.node !== "22.23.2"
) fail("Repository toolchains are not pinned to the reviewed versions.");
for (
  const script of [
    "audit:all",
    "audit:bun",
    "audit:complete",
    "audit:deno",
    "audit:policy",
    "audit:production",
    "audit:runtime",
    "check:artifact",
    "check:container",
    "contracts:check",
    "health:check",
    "website:compat",
  ]
) {
  if (!manifest.scripts?.[script]) fail(`Missing required ${script} script.`);
}
if (manifest.scripts?.["audit:runtime"] !== "bun run audit:production") {
  fail("Runtime dependency audit must fail at high severity.");
}
if (
  manifest.scripts?.["audit:bun"] !== "bun run audit:complete" ||
  manifest.scripts?.["audit:policy"] !==
    "node scripts/audit-dependencies.mjs --check-policy" ||
  manifest.scripts?.["audit:production"] !==
    "node scripts/audit-dependencies.mjs --scope=production" ||
  manifest.scripts?.["audit:complete"] !==
    "node scripts/audit-dependencies.mjs --scope=complete" ||
  manifest.scripts?.["audit:deno"] !== "bun scripts/audit-deno-locks.ts" ||
  manifest.scripts?.["audit:all"] !==
    "bun run audit:policy && bun run audit:production && bun run audit:complete && bun run audit:deno" ||
  !manifest.scripts?.check?.includes("bun run audit:all") ||
  manifest.scripts.check.includes("bun run audit:runtime")
) {
  fail(
    "The Bun and six-lock Deno advisory audits must be enforced by the baseline check.",
  );
}
const denoAuditSource = read("scripts/audit-deno-locks.ts");
const requiredDenoLocks = [
  "supabase/functions/publish-member-spotlight-winner/deno.lock",
  "supabase/functions/reaper-discord-interactions/deno.lock",
  "supabase/functions/reaper-discord-member-sync/deno.lock",
  "supabase/functions/reaper-spinner-dispatch/deno.lock",
  "supabase/functions/send-member-spotlight-poll/deno.lock",
  "supabase/functions/send-vote-reminder/deno.lock",
];
for (const path of requiredDenoLocks) {
  if (!denoAuditSource.includes(`"${path}"`)) {
    fail(`Deno dependency audit omits ${path}.`);
  }
}
for (
  const marker of [
    '["git", "ls-files", "-z"]',
    '"audit"',
    '"--frozen=true"',
    'lock.version !== "5"',
  ]
) {
  if (!denoAuditSource.includes(marker)) {
    fail(`Deno dependency audit omits ${marker}.`);
  }
}
if (/ignore-registry-errors|--ignore\b|--no-lock/u.test(denoAuditSource)) {
  fail("Deno dependency audit must not bypass advisories or lock closure.");
}

const release = json<GatewayRelease>("contracts/gateway-release.v1.json");
const welcomeHash = createHash("sha256")
  .update(WELCOME_DM_MESSAGE, "utf8")
  .digest("hex");
if (
  release.schemaVersion !== 1 ||
  release.status !== "source-only-not-deployed" ||
  release.repository !== "Mochirii-Wushu/Reaper-Discord-Bot" ||
  release.entrypoint !== "dist/index.js" ||
  release.toolchain.bun !== "1.3.14" ||
  release.toolchain.node !== "22.23.2" ||
  release.welcomeDmSha256 !== welcomeHash
) fail("Gateway release contract or approved welcome message drifted.");

const requirements = new Set(release.releaseRequirements);
for (
  const requirement of [
    "immutable-artifact-digest",
    "dependency-sbom",
    "provenance-attestation",
    "readiness-readback",
    "restart-and-session-resume-proof",
    "rollback-proof",
    "workstation-off-proof",
  ]
) {
  if (!requirements.has(requirement)) {
    fail(`Gateway release contract omits ${requirement}.`);
  }
}
if (Object.values(release.activationBoundary).some(Boolean)) {
  fail("The source-only Gateway candidate must remain non-deployable.");
}

const indexSource = read("src/index.ts");
const configSource = read("src/config.ts");
const submitSource = read("src/submit.ts");
const environmentSource = read(".env.example");
const registrationSource = read("src/register-commands.ts");
const expectedIndexSha256 =
  "c6cdba3c9908471c1507f76aa15071b4a4f32727d0944061b002f3664eee251c";
const expectedRegistrationSha256 =
  "a4d92870238c746bc4c6bae01acc2be1c95db6984a9f1db1a7cd7e75b3cabc1b";

function canonicalSourceSha256(value: string): string {
  const normalized = value.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return "";
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function exactGatewayListenerBinding(index: string): boolean {
  const source = ts.createSourceFile(
    "src/index.ts",
    index,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let interactionEventReferences = 0;
  let interactionListenerCalls = 0;
  let gatewayFactoryCalls = 0;
  let exactRegistrations = 0;
  const visit = (node: ts.Node): void => {
    const isInteractionEvent = ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) && node.expression.text === "Events" &&
      node.name.text === "InteractionCreate";
    if (isInteractionEvent) interactionEventReferences += 1;
    if (
      ts.isStringLiteral(node) && node.text === "interactionCreate"
    ) interactionEventReferences += 1;
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "createGalleryGatewayInteractionHandler"
    ) gatewayFactoryCalls += 1;
    if (ts.isCallExpression(node)) {
      const isClientOn = ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "client" &&
        node.expression.name.text === "on";
      const first = node.arguments[0];
      const second = node.arguments[1];
      const firstIsInteractionEvent = Boolean(
        first && ts.isPropertyAccessExpression(first) &&
          ts.isIdentifier(first.expression) &&
          first.expression.text === "Events" &&
          first.name.text === "InteractionCreate",
      );
      if (isClientOn && firstIsInteractionEvent) {
        interactionListenerCalls += 1;
        if (
          node.arguments.length === 2 && second &&
          ts.isCallExpression(second) &&
          ts.isIdentifier(second.expression) &&
          second.expression.text === "createGalleryGatewayInteractionHandler" &&
          second.arguments.length === 1 &&
          ts.isIdentifier(second.arguments[0]) &&
          second.arguments[0].text === "config"
        ) exactRegistrations += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return interactionEventReferences === 1 && interactionListenerCalls === 1 &&
    gatewayFactoryCalls === 1 && exactRegistrations === 1;
}

function exactRegistrationGate(registration: string): boolean {
  const source = ts.createSourceFile(
    "src/register-commands.ts",
    registration,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let loadGalleryCalls = 0;
  let loadConfigCalls = 0;
  let configDeclarations = 0;
  let exactConfigInitializers = 0;
  let registrationCalls = 0;
  let exactRegistrationCalls = 0;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) || declaration.name.text !== "config"
      ) {
        continue;
      }
      configDeclarations += 1;
      if (
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === "loadGalleryConfig" &&
        declaration.initializer.arguments.length === 0
      ) exactConfigInitializers += 1;
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (
        node.expression.text === "loadGalleryConfig" &&
        node.arguments.length === 0
      ) loadGalleryCalls += 1;
      if (node.expression.text === "loadConfig") loadConfigCalls += 1;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "rest" &&
      node.expression.name.text === "put"
    ) {
      registrationCalls += 1;
      const route = node.arguments[0];
      if (
        node.arguments.length === 2 && route && ts.isCallExpression(route) &&
        ts.isPropertyAccessExpression(route.expression) &&
        ts.isIdentifier(route.expression.expression) &&
        route.expression.expression.text === "Routes" &&
        route.expression.name.text === "applicationGuildCommands" &&
        route.arguments.length === 2 &&
        ts.isPropertyAccessExpression(route.arguments[0]) &&
        ts.isIdentifier(route.arguments[0].expression) &&
        route.arguments[0].expression.text === "config" &&
        route.arguments[0].name.text === "discordApplicationId" &&
        ts.isPropertyAccessExpression(route.arguments[1]) &&
        ts.isIdentifier(route.arguments[1].expression) &&
        route.arguments[1].expression.text === "config" &&
        route.arguments[1].name.text === "discordGuildId"
      ) exactRegistrationCalls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return configDeclarations === 1 && exactConfigInitializers === 1 &&
    loadGalleryCalls === 1 && loadConfigCalls === 0 &&
    registrationCalls === 1 && exactRegistrationCalls === 1;
}

function gatewayRollbackBindingValid(
  index: string,
  config: string,
  submit: string,
  environment: string,
  registration: string,
): boolean {
  const handlerStart = submit.indexOf(
    "export function createGalleryGatewayInteractionHandler(",
  );
  const gateAt = submit.indexOf(
    "if (!runtimeConfig.galleryGatewayRollbackEnabled) {",
    handlerStart,
  );
  const configuredSubmitAt = submit.indexOf(
    "submitHandler(interaction, galleryConfigLoader())",
    handlerStart,
  );
  return canonicalSourceSha256(index) === expectedIndexSha256 &&
    canonicalSourceSha256(registration) === expectedRegistrationSha256 &&
    handlerStart >= 0 && gateAt > handlerStart &&
    configuredSubmitAt > gateAt &&
    exactGatewayListenerBinding(index) &&
    exactRegistrationGate(registration) &&
    !index.includes("loadGalleryConfig(") &&
    !index.includes("handleSubmitCommand(") &&
    config.includes(
      'exactDefaultFalseBoolean(\n    env,\n    "REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED",\n  )',
    ) &&
    config.includes("if (!reaperConfig.galleryGatewayRollbackEnabled) {") &&
    environment.split("REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED=false")
        .length === 2;
}
if (
  !gatewayRollbackBindingValid(
    indexSource,
    configSource,
    submitSource,
    environmentSource,
    registrationSource,
  )
) {
  fail(
    "Gallery Gateway rollback must remain exact, default-false, and bypass-free.",
  );
}
const gatewayBindingHostiles = [
  [
    indexSource.replace(
      "createGalleryGatewayInteractionHandler(config)",
      "async () => undefined",
    ),
    configSource,
    submitSource,
    environmentSource,
    registrationSource,
  ],
  [
    `${indexSource}\nloadGalleryConfig();\n`,
    configSource,
    submitSource,
    environmentSource,
    registrationSource,
  ],
  [
    indexSource,
    configSource,
    submitSource.replace(
      "if (!runtimeConfig.galleryGatewayRollbackEnabled) {",
      "if (false && !runtimeConfig.galleryGatewayRollbackEnabled) {",
    ),
    environmentSource,
    registrationSource,
  ],
  [
    indexSource,
    configSource.replace(
      '"REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED"',
      '"REAPER_GALLERY_GATEWAY_ROLLBACK_DISABLED"',
    ),
    submitSource,
    environmentSource,
    registrationSource,
  ],
  [
    indexSource,
    configSource,
    submitSource,
    environmentSource.replace(
      "REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED=false",
      "REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED=true",
    ),
    registrationSource,
  ],
  [
    `${indexSource}\nclient.on(Events.InteractionCreate, createGalleryGatewayInteractionHandler({ ...config, galleryGatewayRollbackEnabled: true }));\n`,
    configSource,
    submitSource,
    environmentSource,
    registrationSource,
  ],
  [
    indexSource,
    configSource,
    submitSource,
    environmentSource,
    registrationSource.replace("loadGalleryConfig()", "loadConfig()"),
  ],
  [
    `${indexSource}\n(client as any).on("interaction" + "Create", async () => fetch("https://example.test"));\n`,
    configSource,
    submitSource,
    environmentSource,
    registrationSource,
  ],
  [
    `${indexSource}\nclient.on(Events["InteractionCreate"], async () => fetch("https://example.test"));\n`,
    configSource,
    submitSource,
    environmentSource,
    registrationSource,
  ],
  [
    indexSource,
    configSource,
    submitSource,
    environmentSource,
    `${registrationSource}\nawait rest["put"](Routes.applicationCommands(config.discordApplicationId), { body: commandData });\n`,
  ],
  [
    indexSource,
    configSource,
    submitSource,
    environmentSource,
    registrationSource.replace(
      "const config = loadGalleryConfig();",
      "if (false) loadGalleryConfig();\nconst config = { discordBotToken: process.env.DISCORD_BOT_TOKEN, discordApplicationId: process.env.DISCORD_APPLICATION_ID, discordGuildId: process.env.DISCORD_GUILD_ID };",
    ),
  ],
];
if (
  gatewayBindingHostiles.some((candidate) =>
    gatewayRollbackBindingValid(
      candidate[0],
      candidate[1],
      candidate[2],
      candidate[3],
      candidate[4],
    )
  )
) fail("Gallery Gateway rollback hostile binding was accepted.");
for (
  const marker of [
    "Events.ShardReconnecting",
    "Events.ShardDisconnect",
    "Events.ShardReady",
    "Events.ShardResume",
    "Events.Invalidated",
    'process.once("SIGTERM"',
  ]
) {
  if (!indexSource.includes(marker)) fail(`Gateway lifecycle omits ${marker}.`);
}
if (indexSource.includes("readyClient.user.tag")) {
  fail("Gateway logs must not expose the connected account tag.");
}

const securityPolicy = read("SECURITY.md");
const operations = read("docs/runtime-operations.md");
const dependencyPolicy = read("docs/dependency-security.md");
for (const marker of ["Security Advisories", "Do not include secrets"]) {
  if (!securityPolicy.includes(marker)) fail(`SECURITY.md omits ${marker}.`);
}
for (
  const marker of [
    "SOURCE_ONLY_NOT_DEPLOYED",
    "REAPER_HEALTH_STATE_PATH",
    "automatic restart",
    "rollback",
    "workstation",
  ]
) {
  if (!operations.includes(marker)) fail(`Runtime runbook omits ${marker}.`);
}
for (
  const marker of [
    "Bun dependency graph",
    "six exact",
    "Deno lock graphs",
    "audit registry",
    "every pull request and push to",
    "monthly dependency review",
    "expiry",
    "review trigger",
  ]
) {
  if (!dependencyPolicy.includes(marker)) {
    fail(`Dependency policy omits ${marker}.`);
  }
}

console.log("Reaper source-only release and security contracts are complete.");
