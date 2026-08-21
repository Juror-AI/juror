#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import net from 'node:net';

function privateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

try {
  const address = readFileSync(0, 'utf8').trim();
  if (net.isIP(address) !== 4 || !privateIpv4(address)) {
    throw new Error('QA egress proxy must have one private IPv4 address on the internal network');
  }
  process.stdout.write(`http://${address}:8080\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Unable to resolve QA egress proxy address: ${message}\n`);
  process.exitCode = 1;
}
