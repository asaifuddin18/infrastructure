# AGENTS.md — infrastructure

This repository holds the AWS infrastructure for personal projects.

## Purpose

All AWS resources are defined and created from this repository. Nothing should
be provisioned by hand in the AWS console — if a resource is needed, it belongs
here as code so it is reproducible and reviewable.

## Repository structure

- One sub-directory **per project**. Each project's AWS resources live in its own
  directory (for example, a directory for the investment dashboard's backend
  resources).
- A **`common/`** directory for shared resources and reusable definitions used
  across more than one project (for example, shared networking, IAM baselines,
  state configuration, or tagging conventions).

```
infrastructure/
├── common/          # shared resources used across projects
├── <project-a>/     # AWS resources for project A
├── <project-b>/     # AWS resources for project B
└── ...
```

## Deployment

- Infrastructure is deployed via a **GitHub Action**. Do not deploy manually.
- Changes should be made in this repo, reviewed, and merged; the GitHub Action
  applies them.

## Conventions

- Keep every AWS resource declared as code within the appropriate project or
  `common/` directory.
- Prefer putting anything shared by multiple projects in `common/` rather than
  duplicating it per project.
