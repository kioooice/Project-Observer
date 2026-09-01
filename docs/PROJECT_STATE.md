# Project Observer — current project state

## Positioning
Project Observer is not a traditional project manager and not another Git dashboard. It is a local-first project memory and observability tool for long-running, AI-assisted software development.

## Core problems
1. Multiple projects become difficult to remember after time passes.
2. AI can make large backend / infrastructure / refactoring changes that users cannot directly experience.
3. Large projects become harder to continue as history, architecture and hidden assumptions accumulate.
4. Existing Git / agent-session dashboards show activity, but not a unified project state model.

## First milestone
A minimal local dashboard that:
- scans a root folder for multiple projects;
- reads basic Git state and recent history;
- reads optional `.project-state.json` files;
- presents a multi-project overview;
- lets Project Observer analyze itself immediately.

## Explicit non-goals for v0.1
- No AI-generated roadmap.
- No guessed next step.
- No cloud account or remote upload.
- No database.
- No desktop packaging yet.

## Evidence model (future)
A project change should eventually distinguish:
- user-experienced;
- automatically verified;
- AI self-reported only;
- not verified.
