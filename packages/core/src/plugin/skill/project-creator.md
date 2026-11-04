# Project Creator & Scaffolder

Use this skill whenever bootstrapping, cloning, porting, or creating a new project, service, or mobile/desktop application.

## Operational Workflow

### 1. Inspect the Request and Research First
- Before creating files or writing code, understand what is being built: its purpose, its users, and the smallest version that proves it works.
- Search for existing reference repositories, official SDKs, and platform templates.
- If porting a repository (e.g. from desktop to Android or Linux to Windows):
  - Clone or inspect the source repository.
  - Research platform-specific adaptations, existing NDK/JNI wrappers, VPN service libraries, or relevant open-source projects on GitHub.
  - Never write custom native layers from scratch if a tested wrapper or library already exists.

### 2. Create the Project and Its Orchestrator — Nothing More, Yet
- Use `workspace_forge` to create the project with the template that matches the TYPE of work (for example `web-app`, `mobile-app`, `desktop-app`, `feature`), or with no template for a plain project.
- A built-in template opens only the project's main Orchestrator session. That is deliberate: the user must not receive a huge team merely for creating a simple project. Do NOT initialize `factory` or `full` — those fixed-roster templates no longer exist.
- Determine the minimum useful initial setup: the directory, the stack's build configuration, and the entry point. Specialists are added later, when the project's actual work requires them — the Orchestrator creates workers lazily from the template's recommended roles.

### 3. Establish Scaffolding & Layered Architecture
- Set up the target workspace directory.
- Initialize build configs (`package.json`, `build.gradle.kts`, `Cargo.toml`, etc.) for the stack the research supports, with reasons recorded when the choice is non-obvious.
- Wire the application entry point and connect foundational dependencies, so the skeleton genuinely runs.

### 4. Generate a Dynamic Definition of Done (`.orchestra/dod.yaml`)
- Define concrete milestones that match THIS project: its stack, its build, its test commands and its packaging. There is no universal milestone list and no fixed count.
- Every milestone's verification must execute real code (build, test runner, typecheck, the packaged artifact actually starting) — never a file-existence check.

### 5. Verify the Real Thing
- Run the project's real build, its tests, and its packaging before concluding. Report which platforms and commands actually ran and which are NOT RUN.
- A project whose skeleton does not build is not created — it is broken. Fix it or report the failure honestly.
