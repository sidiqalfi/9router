import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // The MITM server (src/mitm/server.js) is spawned as a standalone CJS child
  // process. Next's file tracing copies server.js itself (it's required by
  // manager.js), but NOT its sibling modules (./logger, ./config, ./handlers/*,
  // ./cert/*, ./dns/*, ...) because manager.js resolves the path at runtime via
  // path.join — the static tracer can't follow those. Copy the whole src/mitm
  // tree so the spawned process can require its siblings. (#MITM-standalone)
  const mitmSource = resolve(projectRoot, "src", "mitm");
  const mitmDestination = resolve(standaloneDir, "src", "mitm");
  if (existsSync(mitmSource)) {
    cpSync(mitmSource, mitmDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied MITM server tree to ${mitmDestination}`);
  }

  // src/mitm/dns/dnsConfig.js reaches out of the mitm tree into
  // src/shared/constants/mitmToolHosts.js. Next's tracer doesn't follow that
  // cross-tree require, so copy src/shared/constants alongside. Small (~80K),
  // pure-constants, no side effects on import.
  const sharedConstSource = resolve(projectRoot, "src", "shared", "constants");
  const sharedConstDestination = resolve(standaloneDir, "src", "shared", "constants");
  if (existsSync(sharedConstSource)) {
    cpSync(sharedConstSource, sharedConstDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied shared constants to ${sharedConstDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
