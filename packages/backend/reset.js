// Reset both files to clean state.
const fs = require('fs');
const ts = 'src/assistant/tools/salon-copilot-tools.ts';
const spec = 'src/assistant/tools/salon-copilot-tools.l4.spec.ts';
if (fs.existsSync(ts + '.bak')) fs.renameSync(ts + '.bak', ts);
if (fs.existsSync(spec + '.bak')) fs.renameSync(spec + '.bak', spec);
console.log('no backup files; files left as-is');
