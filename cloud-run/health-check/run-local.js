// Run the health check from your machine and print the Chat message instead of
// posting it.
//
//   node run-local.js --project=usdr-md-translate-proto --region=us-central1
//   node run-local.js --project=... --region=... --post   # also post to the webhook
//
// Uses Application Default Credentials. To check what the pipeline itself can
// see, impersonate its service account:
//   gcloud auth application-default login \
//     --impersonate-service-account=<pipeline service account email>

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { runChecks } = require("./run-checks");
const { formatReport, postToChat } = require("./report");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

async function main() {
  const project = arg("project") || process.env.GOOGLE_CLOUD_PROJECT;
  const region = arg("region") || process.env.HEALTH_CHECK_REGION;
  const environment = arg("environment") || process.env.HEALTH_CHECK_ENVIRONMENT || project;
  if (!project || !region) {
    console.error("Usage: node run-local.js --project=<id> --region=<region> [--environment=<name>] [--post]");
    process.exit(1);
  }

  const outcome = await runChecks({ project, region });
  const text = formatReport(outcome, environment);
  console.log(text);
  console.log("\n--- all results ---");
  for (const r of outcome.results) {
    console.log(`${r.status.padEnd(7)} ${r.check} | ${r.resource}${r.detail ? ` | ${r.detail}` : ""}`);
  }

  if (process.argv.includes("--post")) {
    const webhookUrl = process.env.HEALTH_CHECK_CHAT_WEBHOOK_URL;
    if (!webhookUrl) throw new Error("--post needs HEALTH_CHECK_CHAT_WEBHOOK_URL");
    await postToChat(webhookUrl, text);
    console.log("\nPosted to Chat.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
