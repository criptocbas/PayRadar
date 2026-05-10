// Local dev CLI. Vercel cron routes call the same exported functions directly.
import { syncCatalog, runProbes, runScoring } from './index.js';

const cmd = process.argv[2];

async function main() {
  switch (cmd) {
    case 'sync-catalog': {
      console.log(JSON.stringify(await syncCatalog(), null, 2));
      break;
    }
    case 'run-probes': {
      console.log(JSON.stringify(await runProbes(), null, 2));
      break;
    }
    case 'run-scoring': {
      console.log(JSON.stringify(await runScoring(), null, 2));
      break;
    }
    case 'all': {
      const sync = await syncCatalog();
      const probes = await runProbes();
      const scoring = await runScoring();
      console.log(JSON.stringify({ sync, probes, scoring }, null, 2));
      break;
    }
    default:
      console.error('usage: ingestor <sync-catalog|run-probes|run-scoring|all>');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
