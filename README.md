# MoMoA: Mixture of Mixture of Agents

Coordinate independent LLM experts to solve complex, long-running engineering tasks that can exceed the capabilities of single-agent loops.

---

MoMoA breaks large projects into sub-tasks and assigns them to dynamic "Work Phase Rooms." Within each room, two specialized experts—like a **Creative Developer** and a **Conservative Senior Engineer**—are forced to debate, review, and validate each other's work before reporting back to an Orchestrator.

To start a session, point the CLI at your project directory and describe the goal:

```bash
python3 python_cli.py "Refactor the authentication logic to use JWT instead of sessions" \
  --directory ./my-web-app \
  --output ./updates
```

If the Orchestrator encounters an unresolvable ambiguity, it will pause and prompt you for a "Human-in-the-Loop" response directly in your terminal:

```text
----------------------------Question from the agent:----------------------------
I found two different ways to implement the API endpoint. Should I prioritize 
execution speed or memory efficiency for this specific module?
---------------------------------------------------------------------------------

Your answer: Prioritize execution speed; memory is not a bottleneck here.
```

---

MoMoA is an experimental architecture tuned for the Software Development Life Cycle (SDLC). It prioritizes consistency over speed by requiring multiple rounds of internal peer review and validation before any file change is finalized.

### CLI Reference

| Argument | Description | Default |
| --- | --- | --- |
| `positional_prompt` | The primary task description for the agent. | (Required) |
| `-d, --directory` | The local path the agent should read and modify. | `None` |
| `-o, --output` | Where to save worklogs and the final result diffs. | `agent_output` |
| `-a, --assumptions` | Path to a text file containing rules the agent must obey. | `assumptions.txt` |
| `-s, --serverAddress` | The address of the running MoMoA server. | `localhost:3007` |
| `--no-save` | Display diffs and results without writing all files to disk. | `False` |

### Setup & Configuration

1. **Environment:** Create a `.env` file in the server directory with your `GEMINI_API_KEY`
2. **Launch Server:**
```bash
npm install
npm run dev
```
3. **Ignore Rules:** Create an `.agentignore` file in the root of the project folder if you plan to have MoMoA run against an existing project. This follows standard `.gitignore` syntax to prevent the agent from reading heavy dependencies (like `node_modules`) or sensitive secrets.
4. **Launch Client:** 
Ensure you have `websocket-client` installed via pip:
```bash
pip install websocket-client
python3 python_cli.py "Your prompt here" -d ./your-project
```

## Decoupling computation from the server's host environment & distributed Agent environments

MoMoA now includes the **Agent Smart Tool**, a generalized tool that allows our Orchestrator to assign tasks to autonomous sub-agents running within independent, distributed host environments.

This builds upon previous experiments to decouple our Agent's tool execution environments from its host environment, providing access to distributed compute resources as described in [MoMoA Agent Bridge](https://labs.google/code/experiments/agentbridge).

By utilizing an Agent Communication Protocol (ACP) Sandbox acting as an Agent Harness, MoMoA can deploy and manage any ACP-compatible sub-agent across a variety of runtime environments. You can learn more about these distributed Agent environments in [Distributed MoMoA Article](https://labs.google/code/experiments/distributed-momoa).

By default, the Code Runner tool and Agent tool will run within the same execution environment as the server. You can use either server-side environment variables or CLI parameters to provide the configuration values needed for these tools.

MoMoA features two distinct types of distributed environments, both selected using the same `--toolenvironment` CLI argument:
* **Execution Providers (Code Runner Tool):** Used to stage files and execute code scripts (such as Python, Rust, and JavaScript/TypeScript).
* **Agent Environments (Agent Tool):** Used to provision sandboxes, establish data streams, and run autonomous sub-agent sessions.

While setting `--toolenvironment` configures both tools, you must provide the specific arguments required by the underlying implementation of each tool.

### Setup & Configuration

#### CLI Arguments

| Argument | Description |
| --- | --- |
| `--toolenvironment` | Sets the environment for both Execution Providers and Agent Environments. Choices include `LOCAL`, `CLOUDRUN`, `CLOUDSHELLEDITOR`, `CLOUDWORKSTATION`, `E2B`, `INVERSE_SSH_TUNNEL`, and `JULES`. **Note:** `CLOUDSHELLEDITOR` and `INVERSE_SSH_TUNNEL` are only supported by the Code Runner; the Agent Tool will default to `LOCAL` for these choices. |
| `--gcp-token` | Google Cloud Access Token required for Cloud Workstations and Cloud Shell Editor. |
| `--gcp-project-id` | GCP Project ID required for Cloud Workstations and Cloud Shell Editor. |
| `--cloud-workstation-name` | Name of the Cloud Workstation instance to use. |
| `--remote-desktop-key` | Key/ID required to route tasks to a Remote Desktop compute agent. |
| `--cloud-run-proxy-url` | URL of the Cloud Run Agent Proxy service (Required for Agent Environments using Cloud Run). |
| `--cloud-run-token` | Cloud Run OIDC Identity Token used to authenticate the Agent Proxy. |
| `--local-docker-image` | Custom Docker image to use for the Local Agent Environment (e.g., `python:3.11`). |
| `--docker-mounts`, `--docker-network` | Docker volume mounts and network configuration for the Local Agent Environment. |
| `--e2b-api-key` | API key required to use the E2B environment for both tools. |
| `--ssh-tunnel` | SSH Tunnel URL required for the `INVERSE_SSH_TUNNEL` execution provider. |

#### Server Side Environment Variables

Update the `.env` file that contains your `GEMINI_API_KEY` with required keys for the Execution / Agent Environments you will support (such as `GCP_PROJECT_ID`, `CLOUD_RUN_PROXY_URL`, `CLOUD_RUN_TOKEN`, and `E2B_API_KEY`) to ensure the server has reliable fallbacks.

### Server's Local Host Environment

If you set `--toolenvironment LOCAL` (or leave it as the default), the two tools behave differently:
* **Code Runner (Execution Provider):** Defaults to running code directly on your local host machine.
* **Agent Tool (Agent Environment):** Defaults to executing the agent within a local Docker container. You can customize this container using the `--local-docker-image`, `--docker-mounts`, and `--docker-network` arguments.

### E2B.dev

The user must provide a valid E2B.dev API Key using the `--e2b-api-key` CLI argument or `E2B_API_KEY` environment variable.

Navigate to the [E2B.dev Dashboard](https://e2b.dev/dashboard) and copy the API Key from there.

At the time of writing, new E2B accounts automatically receive a one-time free credit on their Hobby tier, with sessions limited to 1 hour and concurrency at 20 sandboxes. Using the E2B provider will eventually use all these credits and the account will eventually require a usage-based Pro plan with billing added.

### Cloud Run

Cloud Run execution enables you to "bring your own" compute resources at runtime using a dedicated Google Cloud project. Because the Code Runner and Agent Tool use different Cloud Run architectures, configuring them requires distinct setups:

* **Code Runner (Execution Provider):** Uses an ephemeral Cloud Run Job configured via your project's hardcoded configuration (`CLOUD_RUN_CONFIG`). Before deploying, you must update the Cloud Run Project configuration values in `src/cloudrun-config.ts`. You must replace `"YOUR_PROJECT_ID"` and `"YOUR_STORAGE_BUCKET"` with your actual Google Cloud Project ID and storage bucket name for the `momoa-code-runner` job to execute properly.
* **Agent Tool (Agent Environment):** Uses a persistent Cloud Run Service Proxy. To use this, you **must** pass the generated service URL via the `--cloud-run-proxy-url` CLI argument or `CLOUD_RUN_PROXY_URL` environment variable, alongside a Cloud Run OIDC token (`--cloud-run-token` / `CLOUD_RUN_TOKEN`).

### Cloud Run Jobs

The other Execution Providers use the user's credentials and API keys to let them 'bring their own' compute resources at runtime. The Cloud Run Jobs Execution Provider uses resources from a dedicated Firebase / Google Cloud project—by default the same service the project is deployed to.

Cloud Run Jobs are ephemeral, non-interactive execution environments that the Execution Provider communicates with via a worker script that is executed within the Job's container and a Google Cloud Storage container. 

#### Prerequisites

You will need a Google Cloud Project with the following services enabled. This can be the same project to which you've deployed the service:
* Cloud Run API
* Cloud Build API
* Cloud Storage API
* Artifact Registry API
* Firebase Storage

#### Deploy the Cloud Run Job

Ensure you have the Google Cloud CLI (`gcloud`) installed and authenticated for the Google Cloud project you're using.

> In the example, we've hard-coded all our services to run in `us-central1`. If you change this, you must update it within the Execution Provider and deployment scripts.

For simplicity, this project uses the same Dockerfile for the containers used for both hosting the service and for the Cloud Run Jobs execution environments. To deploy the Cloud Run Job worker image, run the `/scripts/deploy.sh` deployment script from the project root:

```bash
# Make sure the script is executable
chmod +x scripts/deploy.sh

# Run the deployment script
./scripts/deploy.sh
```

**What this script does:**
1. Builds the main `Dockerfile` (containing Node, Python, and Rust runtimes).
2. Pushes the image to Google Container Registry/Artifact Registry.
3. Creates or updates a Cloud Run Job named `momoa-code-runner` in `us-central1` (matching the hardcoded expectations of the provider).
4. Overrides the container's startup command to run the execution worker instead of the main API server.

#### Granting Permissions to start new Cloud Run Jobs

If you are running MoMoA locally use the Google Cloud CLI to login and use your credentials:
```bash 
gcloud auth application-default login
```

If you deploy MoMoA to Google Cloud Run, you must grant the Service Account it runs with explicit permissions:

**Required IAM Roles:**
*   **Cloud Run Invoker** (`roles/run.invoker`): Allows the main application to programmatically start the `momoa-code-runner` job via the Cloud Run API.
*   **Storage Object Admin** (`roles/storage.objectAdmin`): Allows the application to upload code payloads and download execution results from your Firebase Storage bucket.

### Deploy the Cloud Run Agent Proxy Service

If you intend to use Cloud Run for the Agent Tool (via `--toolenvironment CLOUDRUN`), you must deploy the Cloud Run Agent Proxy. Unlike the Code Runner, this requires a persistent Cloud Run Service configured with session affinity.

Run the proxy deployment script from the project root:

```bash
# Make sure the script is executable
chmod +x scripts/deploy-proxy.sh

# Run the deployment script
./scripts/deploy-proxy.sh
```

**What this script does:**
1. Builds the proxy server Docker image directly from the `src/services/agentOrchestrators/agentWorkers/cloudRunAgentProxyServer` directory.
2. Deploys a Cloud Run Service named `cloud-run-agent-proxy` to `us-central1`.
3. Secures the service by disabling unauthenticated access (`--no-allow-unauthenticated`) and enabling session affinity.
4. Prints the final Service URL to your terminal.

**Using the Proxy:**
Once the deployment completes, the script will output a URL. You must provide this exact URL to your client using the `--cloud-run-proxy-url` CLI argument or the `CLOUD_RUN_PROXY_URL` environment variable. Because the service requires authentication, you must also provide a valid identity token via `--cloud-run-token`.

> **Advanced:** You can pass a specific revision tag as an argument (e.g., `./scripts/deploy-proxy.sh my-tag`) to deploy a tagged revision without immediately routing traffic to it.

### Cloud Workstations

The [Google Cloud CLI tools must be installed](https://docs.cloud.google.com/sdk/docs/install-sdk), initialized, and authorized on the server's host environment.

To authorize access, you can provide a Google Cloud Access Token via the CLI argument (`--gcp-token`) or a server-side environment variable (`GOOGLE_ACCESS_TOKEN`). CLI arguments always take precedence over server environment variables.

If a token is provided, the provider creates an isolated, temporary configuration for that session. If the token is omitted entirely, the provider falls back to using the default gcloud credentials configured on the server's host machine.

You must also specify the following variables. If they are omitted, the environment setup will throw an error and fail:
* A GCP Project ID (`GCP_PROJECT_ID` / `--gcp-project-id`), that includes the specified:
* Cloud Workstation name (`CLOUD_WORKSTATION_NAME` / `--cloud-workstation-name`)

The tools will stage files in a temporary folder within the Cloud Workstation before execution and cleanup.

### Cloud Shell Editor

The Cloud Shell Editor provider uses a nearly identical architecture to the Workstations provider, but routes the execution to the user's Google Cloud Shell environment.

The [Google Cloud CLI tools must be installed](https://docs.cloud.google.com/sdk/docs/install-sdk), initialized, and authorized on the server's host environment.

To authorize access, you can provide a Google Cloud Access Token via the CLI argument (`--gcp-token`) or a server-side environment variable (`GOOGLE_ACCESS_TOKEN`). CLI arguments always take precedence over server environment variables.

If a token is provided, the Cloud Shell Provider creates an isolated, temporary gcloud configuration for that specific access token. If a token is not provided, it falls back to the host machine's default credentials.

You must also specify the following variable (otherwise the environment setup will fail):
*  A GCP Project ID (via `--gcp-project-id` or `GCP_PROJECT_ID`)

### Remote Desktop

The Remote Desktop provider allows the MoMoA orchestrator to dispatch execution tasks directly to a dedicated local compute server. The agent is launched via the command line using the `localComputeCLI.mjs` script. You must configure the `AGENT_ID` environment variable, which must exactly match the `--remote-desktop-key` CLI argument to ensure tasks are routed correctly.

By running locally, the agent can leverage your host hardware, scaling concurrent tasks based on your available CPU cores.

#### Prerequisites

To initialize the local compute server, you must configure the following environment variables:
*   **`AGENT_ID` (Required):** A unique identifier for your local compute server. This value must exactly match the `--remote-desktop-key` CLI argument (or `REMOTE_DESKTOP_AGENT_KEY` environment variable) to ensure tasks are routed correctly.
*   **`SERVER_URL` (Optional):** The URL of your MoMoA backend server. If omitted, it defaults to `http://localhost:3007`.
*   **`GEMINI_API_KEY` (Conditionally Required):** Required if your workflows utilize the local fact-finder script (`local_fact_finder.js`) to parse and read local documents.

#### Starting the Local Compute Server

The agent is launched via the command line using the `localComputeCLI.mjs` script, which is located in the `local-compute-cli` directory. You must pass the path to a local documents folder as a command-line argument, which grants the agent's fact-finder tool access to local files for research tasks.

```bash
# 1. Navigate to the CLI directory
cd local-compute-cli

# 2. Run the agent, passing your environment variables and the path to your docs
GEMINI_API_KEY="your_actual_api_key_here" AGENT_ID="your_secure_agent_id" SERVER_URL="http://localhost:3007" node localComputeCLI.mjs ./your-docs-folder
```

## Adding Support for Jules and Stitch Tools

To enable MoMoA to use the [Stitch](https://stitch.withgoogle.com) and [Jules](https://jules.google.com/) Tools you must sign-up for Jules and / or Stitch, obtain API keys:
* `JULES_API_KEY` can be obtained from Jules following [these instructions](https://developers.google.com/jules/api).
* `STITCH_API_KEY` can be obtained from the Stitch [settings page](https://stitch.withgoogle.com/settings).

The Jules API doesn't currently support repo-less tasks, so you must also provide a GitHub access token that has access to a GitHub repository that is connected to Jules, and in which we can create a temporary branch that the Jules Tool will use to provide access to Jules:
* `GITHUB_TOKEN` can be obtained from [GitHub Developer Settings](https://github.com/settings/tokens).
* `GITHUB_SCRATCHPAD_REPO` (Eg. `myusername/my-private-jules-scratchpad-repo`).

## Key Architecture Components

* **The Orchestrator:** Breaks the prompt into sub-tasks and reviews work phase reports.
* **Work Phase Rooms:** Specialized environments (Engineering, Planning, Documentation) with domain-specific tools.
* **Experts:** Personas with conflicting prompts (e.g., "Skeptical" vs "Creative") designed to catch logical errors through dissent.
* **The Overseer:** A background process that triggers every 15 minutes to unstick the agent if it enters a circular logic loop.

## About this Project

Project Home Page:
https://labs.google/code/experiments/momoa

Code Home:
https://github.com/retomeier/momoa

Maintained by:
Reto Meier

## License
This project is licensed under the Apache 2 License - see the [license.md](LICENSE) file for details.
