'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  'PRIVACY.md',
  'TERMS.md',
  'PAYMENT.md',
  'SECURITY.md',
  'SALES_PLAYBOOK.md',
  'LAUNCH_CHECKLIST.md',
  'site/index.html',
  'site/styles.css',
  'site/assets/always-on-status.png',
  'site/assets/settings.png'
];

const blockers = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) blockers.push(`Missing required release file: ${file}`);
}

for (const file of ['site/index.html', 'PRIVACY.md', 'TERMS.md', 'SECURITY.md']) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) continue;
  const contents = fs.readFileSync(fullPath, 'utf8');
  if (/REPLACE_BEFORE_LAUNCH|replace this section|add the seller's legal name/i.test(contents)) {
    blockers.push(`${file} still needs seller identity/contact details.`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!packageJson.build?.nsis) blockers.push('NSIS installer configuration is missing.');
if (!packageJson.build?.win?.certificateSubjectName && !process.env.WIN_CSC_LINK && !process.env.CSC_LINK) {
  blockers.push('Windows code-signing certificate is not configured.');
}

if (blockers.length) {
  console.error('Commercial release is NOT ready:\n');
  blockers.forEach((blocker) => console.error(`- ${blocker}`));
  console.error('\nSee LAUNCH_CHECKLIST.md for owner actions.');
  process.exitCode = 1;
} else {
  console.log('Commercial release gate passed.');
}
