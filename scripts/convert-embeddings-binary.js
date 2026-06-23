#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  writeBinaryEmbeddingArtifact
} = require('../src/embeddings/embedding-binary.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input || 'embeddings-local.json');
  const defaultOutput = input.toLowerCase().endsWith('.json')
    ? input.replace(/\.json$/i, '.bin')
    : `${input}.bin`;
  const output = path.resolve(args.output || defaultOutput);

  if (input === output) {
    throw new Error('Refusing to overwrite input file; pass --output with a distinct path');
  }

  const artifact = JSON.parse(fs.readFileSync(input, 'utf8'));
  const binary = writeBinaryEmbeddingArtifact(artifact);
  fs.writeFileSync(output, binary);

  const inputBytes = fs.statSync(input).size;
  const outputBytes = fs.statSync(output).size;
  console.log(JSON.stringify({
    input: path.relative(process.cwd(), input),
    output: path.relative(process.cwd(), output),
    inputBytes,
    outputBytes,
    ratio: Number((outputBytes / inputBytes).toFixed(4)),
    savedBytes: inputBytes - outputBytes
  }));
}

main();
