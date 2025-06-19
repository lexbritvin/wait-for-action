import * as core from "@actions/core";
import * as github from "@actions/github";
import * as fs from "fs";
import * as path from "path";

async function run() {
  try {
    // Detect if we're in a post action by checking for saved state
    const isPostAction = core.getState("IS_POST") === "true";
    const detached = core.getInput("detached").toLowerCase() === "true";

    // In main action phase
    if (!isPostAction) {
      // Save state for post action and skip main execution
      core.saveState("IS_POST", "true");
      if (detached) {
        core.info("🔄 Detached mode enabled - wait operation will run in post action phase");
        return;
      }
      // Continue with normal execution for non-detached mode
    } else {
      // In post action phase - only proceed if we saved the detached state
      if (!detached) {
        core.info("ℹ️ Post action phase - skipping (detached mode not enabled)");
        return;
      }
    }

    const config = {
      conditionType: core.getInput("condition-type", { required: true }),
      filePath: core.getInput("file-path"),
      artifactName: core.getInput("artifact-name"),
      jobName: core.getInput("job-name"),
      repository: core.getInput("repository"),
      runId: core.getInput("run-id"),
      timeoutSeconds: parseInt(core.getInput("timeout-seconds")),
      pollIntervalSeconds: parseInt(core.getInput("poll-interval-seconds")),
      githubToken: core.getInput("github-token"),
    };

    validateConfig(config);

    const startTime = Date.now();
    const timeoutMs = config.timeoutSeconds * 1000;

    const phaseInfo = isPostAction ? "post action phase" : "main action phase";
    core.info(`🕒 Starting wait for ${config.conditionType} in ${phaseInfo} with timeout of ${config.timeoutSeconds} seconds`);

    const octokit = github.getOctokit(config.githubToken);
    const [owner, repo] = config.repository.split("/");

    while (Date.now() - startTime < timeoutMs) {
      const result = await checkCondition(config, octokit, owner, repo);

      if (result.met) {
        core.setOutput("result", "success");
        core.setOutput("message", result.message);

        // Check if the message indicates job failure
        if (result.message.includes("failed:")) {
          core.warning(`⚠️ Job(s) completed but failed: ${result.message}`);
          core.setFailed(result.message);
        } else {
          core.info(`✅ Condition met: ${result.message}`);
        }
        return;
      }

      core.info(`⏳ Condition not met yet: ${result.message}`);
      await sleep(config.pollIntervalSeconds * 1000);
    }

    // Timeout reached
    const timeoutMessage = `Timeout reached after ${config.timeoutSeconds} seconds`;
    core.setOutput("result", "timeout");
    core.setOutput("message", timeoutMessage);
    core.setFailed(timeoutMessage);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    core.setOutput("result", "error");
    core.setOutput("message", errorMessage);
    core.setFailed(errorMessage);
  }
}

function validateConfig(config) {
  switch (config.conditionType) {
    case "file":
      if (!config.filePath) {
        throw new Error("file-path is required when condition-type is file");
      }
      break;
    case "artifact":
      if (!config.artifactName) {
        throw new Error("artifact-name is required when condition-type is artifact");
      }
      break;
    case "job":
      if (!config.jobName) {
        throw new Error("job-name is required when condition-type is job");
      }
      break;
    default:
      throw new Error(`Invalid condition-type: ${config.conditionType}. Must be one of: file, artifact, job`);
  }
}

async function checkCondition(config, octokit, owner, repo) {
  switch (config.conditionType) {
    case "file":
      return checkFileCondition(config.filePath);

    case "artifact":
      return await checkArtifactCondition(config, octokit, owner, repo);

    case "job":
      return await checkJobCondition(config, octokit, owner, repo);

    default:
      throw new Error(`Unsupported condition type: ${config.conditionType}`);
  }
}

function checkFileCondition(filePath) {
  const absolutePath = path.resolve(filePath);
  const exists = fs.existsSync(absolutePath);

  return {
    met: exists,
    message: exists
      ? `File exists: ${absolutePath}`
      : `File does not exist: ${absolutePath}`,
  };
}

async function checkArtifactCondition(config, octokit, owner, repo) {
  try {
    const { data: artifacts } = await octokit.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: parseInt(config.runId),
    });

    const artifact = artifacts.artifacts.find(a => a.name === config.artifactName);

    return {
      met: !!artifact,
      message: artifact
        ? `Artifact found: ${config.artifactName}`
        : `Artifact not found: ${config.artifactName}`,
    };
  } catch (error) {
    return {
      met: false,
      message: `Error checking artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function checkJobCondition(config, octokit, owner, repo) {
  try {
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: parseInt(config.runId),
    });

    // Support both exact names and regex patterns
    const targetPattern = config.jobName;
    let matchingJobs;

    if (targetPattern.startsWith("/") && targetPattern.endsWith("/")) {
      // Regex pattern: "/test.*/" or "/build-\d+/"
      const regexStr = targetPattern.slice(1, -1); // Remove leading/trailing slashes
      const regex = new RegExp(regexStr, "i");
      matchingJobs = jobs.jobs.filter(j => regex.test(j.name));
    } else {
      // Prefix-based matching (safer default)
      const escapedName = escapeRegex(targetPattern);
      const regex = new RegExp(`^${escapedName}(?:[\\s\\-_(]|$)`, "i");
      matchingJobs = jobs.jobs.filter(j => regex.test(j.name));
    }

    return await processMatchingJobs(matchingJobs, targetPattern, jobs.jobs);
  } catch (error) {
    return {
      met: false,
      message: `Error checking job: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function processMatchingJobs(matchingJobs, targetName, allJobs) {
  if (matchingJobs.length === 0) {
    const availableJobs = allJobs.map(j => j.name).join(", ");
    return {
      met: false,
      message: `No jobs found matching: "${targetName}". Available jobs: ${availableJobs}`,
    };
  }

  // Check completion status
  const incompleteJobs = matchingJobs.filter(j => j.status !== "completed");

  if (incompleteJobs.length > 0) {
    const runningJobs = incompleteJobs.map(j => `${j.name} (${j.status})`).join(", ");
    return {
      met: false,
      message: `${incompleteJobs.length}/${matchingJobs.length} job(s) not completed: ${runningJobs}`,
    };
  }

  // All completed - check conclusions
  const failedJobs = matchingJobs.filter(j => j.conclusion !== "success");

  if (failedJobs.length > 0) {
    const failedDetails = failedJobs.map(j => `${j.name} (${j.conclusion})`).join(", ");
    return {
      met: true, // Consider failed jobs as condition met (job finished)
      message: `${failedJobs.length}/${matchingJobs.length} job(s) failed: ${failedDetails}`,
    };
  }

  return {
    met: true,
    message: `All ${matchingJobs.length} job(s) completed successfully: ${matchingJobs.map(j => j.name).join(", ")}`,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

await run();