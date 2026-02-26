#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { Firestore } from "firebase-admin/firestore";

const EXCLUDED_ROOT_COLLECTIONS = new Set(["adminUsers"]);
const WRITE_BATCH_LIMIT = 450;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, "..");

function printUsage() {
  console.log(`
${pc.bold("Seed Firestore Emulator From Production")}

Copies all root collections and nested subcollections from production Firestore
to the local emulator, excluding: ${Array.from(EXCLUDED_ROOT_COLLECTIONS).join(", ")}

Usage:
  node scripts/seed-emulator-from-prod.mjs [options]

Options:
  --project <id>           Firebase project ID (default: infer from .firebaserc)
  --emulator-host <host>   Emulator host:port (default: 127.0.0.1:5010)
  --wipe                   Clear emulator collections first (except excluded roots)
  --dry-run                Show what would be copied without writing data
  -h, --help               Show this help
`);
}

function parseArgs(argv) {
  const options = {
    projectId: "",
    emulatorHost: "127.0.0.1:5010",
    wipe: false,
    dryRun: false,
    help: false,
  };

  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--wipe") {
      options.wipe = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--project") {
      options.projectId = nextValue(i, "--project");
      i += 1;
      continue;
    }
    if (arg.startsWith("--project=")) {
      options.projectId = arg.slice("--project=".length);
      continue;
    }
    if (arg === "--emulator-host") {
      options.emulatorHost = nextValue(i, "--emulator-host");
      i += 1;
      continue;
    }
    if (arg.startsWith("--emulator-host=")) {
      options.emulatorHost = arg.slice("--emulator-host=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parseEmulatorHost(rawHost) {
  const raw = String(rawHost || "").trim();
  if (!raw) {
    throw new Error("Emulator host cannot be empty.");
  }

  const input = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid emulator host: ${raw}`);
  }

  const hostname = url.hostname.toLowerCase();
  const port = url.port || "8080";
  if (!["localhost", "127.0.0.1"].includes(hostname)) {
    throw new Error(
      `Refusing non-local emulator host "${raw}". Use localhost/127.0.0.1 only.`
    );
  }

  return { hostname, port, hostPort: `${hostname}:${port}` };
}

async function inferProjectId() {
  const envProjectId =
    process.env.FIREBASE_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    "";
  if (envProjectId) return envProjectId;

  try {
    const firebasercPath = path.join(projectRoot, ".firebaserc");
    const raw = await fs.readFile(firebasercPath, "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.projects?.default || "").trim();
  } catch {
    return "";
  }
}

async function assertEmulatorReachable(db, hostPort) {
  try {
    await db.listCollections();
  } catch (error) {
    throw new Error(
      `Could not connect to Firestore emulator at ${hostPort}. Start it with:\n` +
        `firebase emulators:start --only firestore,auth,hosting,functions`
    );
  }
}

async function wipeEmulatorData(emulatorDb, stats, dryRun) {
  const rootCollections = await emulatorDb.listCollections();
  const wipeTargets = rootCollections.filter(
    (collection) => !EXCLUDED_ROOT_COLLECTIONS.has(collection.id)
  );

  if (!wipeTargets.length) {
    console.log(pc.dim("No emulator collections to wipe."));
    return;
  }

  console.log(pc.yellow(`Wiping ${wipeTargets.length} emulator root collections...`));
  for (const collectionRef of wipeTargets) {
    if (dryRun) {
      console.log(pc.dim(`[dry-run] would wipe "${collectionRef.id}"`));
      continue;
    }
    await emulatorDb.recursiveDelete(collectionRef);
    stats.collectionsWiped += 1;
    console.log(pc.dim(`wiped "${collectionRef.id}"`));
  }
}

async function copyCollectionRecursive({
  sourceDb,
  emulatorDb,
  collectionPath,
  stats,
  dryRun,
}) {
  const sourceCollection = sourceDb.collection(collectionPath);
  const snapshot = await sourceCollection.get();

  stats.collectionsVisited += 1;
  if (snapshot.empty) {
    console.log(pc.dim(`${collectionPath} (0 docs)`));
    return;
  }

  console.log(pc.cyan(`${collectionPath} (${snapshot.size} docs)`));
  stats.collectionsCopied += 1;

  if (!dryRun) {
    let batch = emulatorDb.batch();
    let writesInBatch = 0;

    for (const docSnap of snapshot.docs) {
      const emulatorDocRef = emulatorDb.doc(docSnap.ref.path);
      batch.set(emulatorDocRef, docSnap.data(), { merge: false });
      writesInBatch += 1;
      stats.docsCopied += 1;

      if (writesInBatch >= WRITE_BATCH_LIMIT) {
        await batch.commit();
        stats.batchCommits += 1;
        batch = emulatorDb.batch();
        writesInBatch = 0;
      }
    }

    if (writesInBatch > 0) {
      await batch.commit();
      stats.batchCommits += 1;
    }
  } else {
    stats.docsCopied += snapshot.size;
  }

  for (const docSnap of snapshot.docs) {
    const subcollections = await docSnap.ref.listCollections();
    for (const subcollection of subcollections) {
      await copyCollectionRecursive({
        sourceDb,
        emulatorDb,
        collectionPath: subcollection.path,
        stats,
        dryRun,
      });
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const projectId = options.projectId || (await inferProjectId());
  if (!projectId) {
    throw new Error(
      "Project ID not found. Pass --project <id> or set FIREBASE_PROJECT/GCLOUD_PROJECT."
    );
  }

  const emulator = parseEmulatorHost(options.emulatorHost);

  // Keep source reads pointed at production even if FIRESTORE_EMULATOR_HOST is set in shell.
  delete process.env.FIRESTORE_EMULATOR_HOST;

  const sourceDb = new Firestore({ projectId });
  const emulatorDb = new Firestore({
    projectId,
    host: emulator.hostPort,
    ssl: false,
  });

  await assertEmulatorReachable(emulatorDb, emulator.hostPort);

  const stats = {
    collectionsVisited: 0,
    collectionsCopied: 0,
    collectionsWiped: 0,
    docsCopied: 0,
    batchCommits: 0,
  };

  console.log(pc.bold("Seeding Firestore emulator"));
  console.log(`project: ${pc.bold(projectId)}`);
  console.log(`emulator: ${pc.bold(emulator.hostPort)}`);
  console.log(
    `excluded roots: ${pc.bold(Array.from(EXCLUDED_ROOT_COLLECTIONS).join(", "))}`
  );
  if (options.dryRun) {
    console.log(pc.yellow("dry-run mode (no writes)"));
  }

  if (options.wipe) {
    await wipeEmulatorData(emulatorDb, stats, options.dryRun);
  }

  const rootCollections = await sourceDb.listCollections();
  const copyTargets = rootCollections
    .filter((collection) => !EXCLUDED_ROOT_COLLECTIONS.has(collection.id))
    .map((collection) => collection.path)
    .sort();

  if (!copyTargets.length) {
    console.log(pc.yellow("No collections found to copy."));
    return;
  }

  for (const collectionPath of copyTargets) {
    await copyCollectionRecursive({
      sourceDb,
      emulatorDb,
      collectionPath,
      stats,
      dryRun: options.dryRun,
    });
  }

  console.log("");
  console.log(pc.bold("Done."));
  console.log(`collections visited: ${stats.collectionsVisited}`);
  console.log(`collections copied: ${stats.collectionsCopied}`);
  if (options.wipe) console.log(`collections wiped: ${stats.collectionsWiped}`);
  console.log(`documents copied: ${stats.docsCopied}`);
  if (!options.dryRun) console.log(`batch commits: ${stats.batchCommits}`);
}

main().catch((error) => {
  console.error(pc.red(error?.stack || error?.message || String(error)));
  console.error(
    pc.dim(
      "If production auth fails, run `gcloud auth application-default login` " +
        "or set GOOGLE_APPLICATION_CREDENTIALS to a service account key."
    )
  );
  process.exit(1);
});
