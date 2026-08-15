# UpgradeCheck Action

Scan exported **n8n workflow JSON files** in CI for AI model IDs that UpgradeCheck currently lists as **retiring** or **retired**.

The action is free and does not upload your workflow files to UpgradeCheck. It only downloads the public lifecycle registry from `https://upgradecheck.vercel.app/api/v1/models` and performs the comparison inside the GitHub Actions runner.

## Quick start

```yaml
name: Check AI model lifecycle

on:
  push:
  pull_request:

jobs:
  upgradecheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Jakobconcepts/upgradecheck-action@v1
        with:
          path: .
          fail-on: retired
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `path` | `.` | File or directory containing exported n8n workflow JSON files. |
| `fail-on` | `retired` | `retired` fails only for retired models; `retiring` fails for retiring or retired models; `none` reports findings without failing. |

## Outputs

- `issue-count`
- `retired-count`
- `retiring-count`

## What it checks

UpgradeCheck looks only at JSON files that resemble exported n8n workflows (`nodes` array present). It compares short strings in node parameters against exact model IDs in the UpgradeCheck registry, with limited support for Google `models/...` and OpenAI fine-tune `ft:...` wrappers.

It does **not** inspect credential objects and does not send workflow JSON, node names, prompts, credentials, or user identity to UpgradeCheck.

## Important limitations

A clean result means no retiring or retired model ID from the **current UpgradeCheck registry** matched the scanned workflows. It is not proof that every model is covered, and dynamically constructed model IDs may not be detectable by static scanning.

Recommended replacements come from curated provider lifecycle data. Always test a replacement before changing a production workflow.

## UpgradeCheck

Use the browser scanner and model lifecycle pages at **https://upgradecheck.vercel.app**.

This repository contains only the public GitHub Action. The UpgradeCheck SaaS application is maintained separately.
