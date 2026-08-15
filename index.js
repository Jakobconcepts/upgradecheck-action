'use strict';

const fs = require('fs');
const path = require('path');

const REGISTRY_URL = 'https://upgradecheck.vercel.app/api/v1/models';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage']);

function input(name, fallback = '') {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (process.env[key] || fallback).trim();
}

function command(name, message, properties = {}) {
  const props = Object.entries(properties)
    .map(([key, value]) => `${key}=${String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/,/g, '%2C').replace(/:/g, '%3A')}`)
    .join(',');
  const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::${name}${props ? ` ${props}` : ''}::${escaped}\n`);
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `${name}=${value}\n`, 'utf8');
}

function appendSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  fs.appendFileSync(summaryFile, `${markdown}\n`, 'utf8');
}

function collectJsonFiles(target) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Scan path does not exist: ${target}`);
  }

  const files = [];
  const visit = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(entry))) return;
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    if (stat.isFile() && entry.toLowerCase().endsWith('.json') && stat.size <= MAX_FILE_BYTES) {
      files.push(entry);
    }
  };

  visit(resolved);
  return files;
}

function collectStrings(value, out, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return out;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= 200) out.add(trimmed);
    return out;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out, depth + 1);
    return out;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'credentials') continue;
      collectStrings(child, out, depth + 1);
    }
  }

  return out;
}

function matchesModel(candidate, modelId) {
  const value = String(candidate).toLowerCase();
  const id = String(modelId).toLowerCase();
  return value === id || value === `models/${id}` || value.startsWith(`ft:${id}:`);
}

function parseWorkflow(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.nodes)) {
    return null;
  }

  return data;
}

async function fetchRegistry() {
  const response = await fetch(REGISTRY_URL, {
    method: 'GET',
    headers: { 'user-agent': 'upgradecheck-action' },
  });

  if (!response.ok) {
    throw new Error(`UpgradeCheck registry request failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.models)) {
    throw new Error('UpgradeCheck registry returned an unexpected response.');
  }
  return data.models;
}

function inspectWorkflow(workflow, file, affectedModels) {
  const results = [];

  for (const node of workflow.nodes) {
    const candidates = collectStrings(node && node.parameters ? node.parameters : {}, new Set());

    for (const model of affectedModels) {
      if (![...candidates].some((candidate) => matchesModel(candidate, model.modelId))) continue;

      results.push({
        file,
        workflowName: typeof workflow.name === 'string' && workflow.name ? workflow.name : path.basename(file),
        nodeName: node && typeof node.name === 'string' ? node.name : '(unnamed node)',
        provider: model.provider || 'unknown',
        modelId: model.modelId,
        status: model.status,
        retirementDate: model.retirementDate || '',
        replacement: Array.isArray(model.replacement) ? model.replacement.join(', ') : '',
        sourceUrl: model.sourceUrl || '',
      });
    }
  }

  return results;
}

function shouldFail(mode, results) {
  if (mode === 'none') return false;
  if (mode === 'retiring') return results.some((item) => item.status === 'retiring' || item.status === 'retired');
  return results.some((item) => item.status === 'retired');
}

async function main() {
  const scanPath = input('path', '.');
  const failOn = input('fail-on', 'retired').toLowerCase();

  if (!['retired', 'retiring', 'none'].includes(failOn)) {
    throw new Error(`Invalid fail-on value: ${failOn}. Use retired, retiring, or none.`);
  }

  const files = collectJsonFiles(scanPath);
  const registry = await fetchRegistry();
  const affectedModels = registry.filter((model) => model.status === 'retired' || model.status === 'retiring');

  const findings = [];
  let workflowCount = 0;

  for (const file of files) {
    const workflow = parseWorkflow(file);
    if (!workflow) continue;
    workflowCount += 1;
    findings.push(...inspectWorkflow(workflow, path.relative(process.cwd(), file) || file, affectedModels));
  }

  const retiredCount = findings.filter((item) => item.status === 'retired').length;
  const retiringCount = findings.filter((item) => item.status === 'retiring').length;

  setOutput('issue-count', findings.length);
  setOutput('retired-count', retiredCount);
  setOutput('retiring-count', retiringCount);

  if (findings.length === 0) {
    console.log(`UpgradeCheck: scanned ${workflowCount} n8n workflow(s); no retiring or retired model IDs matched the current registry.`);
    appendSummary(`## UpgradeCheck\n\n✅ Scanned **${workflowCount}** n8n workflow(s). No retiring or retired model IDs matched the current registry.\n\n> This is not a guarantee that every model is covered by the registry.`);
    return;
  }

  for (const finding of findings) {
    const level = finding.status === 'retired' ? 'error' : 'warning';
    const date = finding.retirementDate ? ` Retirement date: ${finding.retirementDate}.` : '';
    const replacement = finding.replacement ? ` Replacement: ${finding.replacement}.` : '';
    command(level, `${finding.modelId} is ${finding.status}.${date}${replacement}`, {
      file: finding.file,
      title: `UpgradeCheck: ${finding.status} AI model`,
    });
  }

  const rows = findings
    .map((item) => `| ${item.status} | \`${item.modelId}\` | ${item.workflowName} | ${item.nodeName} | ${item.retirementDate || '—'} | ${item.replacement || '—'} |`)
    .join('\n');

  appendSummary(`## UpgradeCheck\n\nFound **${findings.length}** lifecycle issue(s) across **${workflowCount}** n8n workflow(s).\n\n| Status | Model | Workflow | Node | Retirement | Replacement |\n|---|---|---|---|---|---|\n${rows}\n\nLifecycle data: ${REGISTRY_URL}\n\nLearn more: https://upgradecheck.vercel.app`);

  console.log(`UpgradeCheck: found ${retiredCount} retired and ${retiringCount} retiring model reference(s).`);

  if (shouldFail(failOn, findings)) {
    throw new Error(`UpgradeCheck found AI model lifecycle issues that match fail-on=${failOn}.`);
  }
}

main().catch((error) => {
  command('error', error instanceof Error ? error.message : String(error), { title: 'UpgradeCheck failed' });
  process.exitCode = 1;
});
