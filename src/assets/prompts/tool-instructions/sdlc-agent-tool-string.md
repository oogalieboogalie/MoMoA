---
name: "sdlc-agent-tool-string"
---
**SDLC Agent Tool (${strings/tool-prefix}SDLC_AGENT)**
* **Purpose:** The SDLC Agent has access to a build and test environment and is capable of making changes to code; building, running, and testing software projects. It can operate on multiple files in one session and is capable of running End-to-End (E2E) tests using the Playwright browser automation tool to validate UI, interactions, and full application flows.
* **Syntax:** ${strings/tool-prefix}SDLC_AGENT{A clear, concise, yet comprehensive software  task that you want completed. Include comprehensive background information, including goals, constraints, prior attempts, current hypotheses, and any other relevant details that will help the SDLC Agent understand the full scope of the request. It will have access to all the files in the project but no other information (You MUST include curly braces).}
* **Rules and Usage:**
  * The SDLC agent's environment setup is **not** persisted between tool invocations.
  * The SDLC Agent is a powerful and holistic agent and it will attempt to solve a task completely. To avoid unexpected outcomes, you must **carefully** scope your requests to prevent unintended actions. Treat the agent like a very capable but literal-minded junior developer; you must give it explicit and detailed instructions on what it must do and **what it must not do**, particularly when you want it to perform a simple task.
  * For example:
    * If you want to run tests without modifying code you must be explicit:
```
You are in Test & Report Mode. You will create a working build and test environment and run the specified tests.
If tests fail due to logic in the source code, you must stop and report the failures. Do not 'fix' the source code and don't implement workarounds in the tests if there is a more "correct" solution, in which case you should stop and report the better solution.
Your purpose is to act as a QA tool, not a developer, so your report **must** include explicitly include a summary of the failures, and the likely cause of the failures, as well as your recommendations for how to resolve the failures. You **must** include your observations and recommendation in your final response, in addition to any status updates.
```
  * When using the SDLC Agent to run tests: 
    * Playwright and Playwright browsers are NOT pre-installed. If your task involves E2E tests, you **MUST** explicitly instruct the SDLC Agent to run `npx playwright install` followed by `npx playwright install-deps` before running the Playwright tests, or they will fail.
    * If you want the SDLC Agent to return specific test artifacts (Eg. Logs) you must ask for them specifically.
  * If the SDLC Agent provides good advice and recommendations, you should follow it if it doesn't contradict your goals or restrictions.
  * If the SDLC Agent suggests solutions to failing tests, you should consider them carefully -- particularly if there are test results proving their efficacy.
  * The SDLC Agent is very good at:
    * Validating an applications is Renderering correctly by using Playwright to validate rendering and visualizations, and checking for visual regressions or rendering errors.
    * Resolving lint errors. If your goal is to resolve lint errors, you must ask the SDLC Agent to do this for you.
    * Building projects and resolving build errors. If you need to resolve build errors, you must ask the SDLC Agent to do this for you.
    * Running tests (Unit, Integration, and Browser Automation / E2E) and reporting on the test failures.
  * The SDLC Agent is expensive to run, so it's good practice to check for syntax errors using other tools **before** using it.