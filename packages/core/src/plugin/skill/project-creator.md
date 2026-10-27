# Project Creator & Multi-Agent Scaffolder

Use this skill whenever bootstrapping, cloning, porting, or creating a new project, service, or mobile/desktop application.

## Operational Workflow

### 1. Research & Scout Existing Repositories First
- Before creating files or writing code, search for existing reference repositories, official SDKs, and platform templates.
- If porting a repository (e.g. from desktop to Android or Linux to Windows):
  - Clone or inspect the source repository.
  - Research platform-specific adaptations, existing NDK/JNI wrappers, VPN service libraries, or relevant open-source projects on GitHub.
  - Never write custom native layers from scratch if a tested wrapper or library already exists.

### 2. Assemble the Full Team (The Factory)
- Use `workspace_forge` with `team="factory"` (or `team="full"`) to initialize the project with its dedicated AI team:
  - **Scout/Researcher**
  - **Lead Architect**
  - **Developers (Core & Integration)**
  - **QA & Test Engineer**
  - **Security Reviewer**

### 3. Establish Scaffolding & Layered Architecture
- Set up target workspace directory.
- Initialize build configs (`package.json`, `build.gradle.kts`, `Cargo.toml`, etc.).
- Wire application entry point and connect foundational dependencies.

### 4. Auto-Generate Definition of Done (`.orchestra/dod.yaml`)
- Define concrete milestones across research, contracts, implementation, test verification, and packaging.

### 5. Multi-Agent Verification
- Have QA & Test Engineer write and execute test suites.
- Verify exit-0 on all checks before concluding.
