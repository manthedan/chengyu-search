const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'frontend-utils.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(source, sandbox);
const { splitMeaningNote } = sandbox.window.ChengyuFrontendUtils;

test('lifts a CEDICT idiom note out of the meaning', () => {
    assert.deepEqual({ ...splitMeaningNote('one word says it all (idiom, from Analects); to cut a long story short') },
        { text: 'one word says it all; to cut a long story short', note: 'from Analects' });
    assert.deepEqual({ ...splitMeaningNote('x (idiom from Zhuangzi); y') }, { text: 'x; y', note: 'from Zhuangzi' });
});

test('drops a bare (idiom) and leaves other brackets alone', () => {
    assert.deepEqual({ ...splitMeaningNote("to suffer a setback (idiom); to fall (as by an arrow)") },
        { text: 'to suffer a setback; to fall (as by an arrow)', note: '' });
    assert.deepEqual({ ...splitMeaningNote('a blessing (idiomatic blessing)') }, { text: 'a blessing (idiomatic blessing)', note: '' });
    assert.deepEqual({ ...splitMeaningNote('') }, { text: '', note: '' });
});
