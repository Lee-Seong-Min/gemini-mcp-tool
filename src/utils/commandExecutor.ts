import { spawn, ChildProcess } from "child_process";
import { Logger } from "./logger.js";

const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function executeCommand(
  command: string,
  args: string[],
  onProgress?: (newOutput: string) => void,
  cwd?: string,
  stdinData?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    Logger.commandExecution(command, args, startTime);

    const childProcess = spawn(command, args, {
      env: process.env,
      shell: process.platform === "win32",
      stdio: [stdinData ? "pipe" : "ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });

    // Write stdin data and close the stream
    if (stdinData && childProcess.stdin) {
      childProcess.stdin.on("error", (err) => {
        // EPIPE is expected if process exits before stdin is fully written
        if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
          Logger.error(`stdin write error: ${err.message}`);
        }
      });
      childProcess.stdin.write(stdinData);
      childProcess.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let isResolved = false;
    let lastReportedLength = 0;

    // Timeout guard: kill process if it runs too long
    const timeout = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        childProcess.kill("SIGTERM");
        Logger.error(`Process timed out after ${PROCESS_TIMEOUT_MS / 1000}s`);
        reject(new Error(`Process timed out after ${PROCESS_TIMEOUT_MS / 1000} seconds`));
      }
    }, PROCESS_TIMEOUT_MS);

    childProcess.stdout!.on("data", (data) => {
      stdout += data.toString();

      if (onProgress && stdout.length > lastReportedLength) {
        const newContent = stdout.substring(lastReportedLength);
        lastReportedLength = stdout.length;
        onProgress(newContent);
      }
    });

    childProcess.stderr!.on("data", (data) => {
      stderr += data.toString();
      if (stderr.includes("RESOURCE_EXHAUSTED")) {
        const modelMatch = stderr.match(/Quota exceeded for quota metric '([^']+)'/);
        const statusMatch = stderr.match(/status["\s]*[:=]\s*(\d+)/);
        const reasonMatch = stderr.match(/"reason":\s*"([^"]+)"/);
        const model = modelMatch ? modelMatch[1] : "Unknown Model";
        const status = statusMatch ? statusMatch[1] : "429";
        const reason = reasonMatch ? reasonMatch[1] : "rateLimitExceeded";
        const errorJson = {
          error: {
            code: parseInt(status),
            message: `GMCPT: --> Quota exceeded for ${model}`,
            details: {
              model,
              reason,
              statusText: "Too Many Requests --> try using gemini-2.5-flash by asking",
            }
          }
        };
        Logger.error(`Gemini Quota Error: ${JSON.stringify(errorJson, null, 2)}`);
      }
    });

    childProcess.on("error", (error) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        Logger.error(`Process error:`, error);
        reject(new Error(`Failed to spawn command: ${error.message}`));
      }
    });

    childProcess.on("close", (code) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeout);
        if (code === 0) {
          Logger.commandComplete(startTime, code, stdout.length);
          resolve(stdout.trim());
        } else {
          Logger.commandComplete(startTime, code);
          Logger.error(`Failed with exit code ${code}`);
          const errorMessage = stderr.trim() || "Unknown error";
          reject(
            new Error(`Command failed with exit code ${code}: ${errorMessage}`),
          );
        }
      }
    });
  });
}