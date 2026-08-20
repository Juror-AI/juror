/** Minimal, fail-closed TLS ClientHello SNI parser for CONNECT authorization. */

const MAX_HELLO_BYTES = 64 * 1024;

export function inspectTlsClientHello(input) {
  if (!Buffer.isBuffer(input) || input.length > MAX_HELLO_BYTES) return { state: 'invalid' };
  let offset = 0;
  const handshakeParts = [];
  let handshakeBytes = 0;
  while (offset + 5 <= input.length) {
    const type = input[offset];
    const length = input.readUInt16BE(offset + 3);
    if (length < 1 || length > 18_432) return { state: 'invalid' };
    if (offset + 5 + length > input.length) return { state: 'more' };
    if (type !== 22) return { state: 'invalid' };
    const payload = input.subarray(offset + 5, offset + 5 + length);
    handshakeParts.push(payload);
    handshakeBytes += payload.length;
    if (handshakeBytes > MAX_HELLO_BYTES) return { state: 'invalid' };
    const handshake = Buffer.concat(handshakeParts, handshakeBytes);
    if (handshake.length >= 4) {
      if (handshake[0] !== 1) return { state: 'invalid' };
      const helloLength = handshake.readUIntBE(1, 3);
      if (helloLength > MAX_HELLO_BYTES) return { state: 'invalid' };
      if (handshake.length >= helloLength + 4) return parseHello(handshake.subarray(4, helloLength + 4));
    }
    offset += 5 + length;
  }
  return { state: 'more' };
}

function parseHello(hello) {
  // legacy_version + random
  let offset = 34;
  if (hello.length < offset + 1) return { state: 'invalid' };
  const sessionLength = hello[offset];
  offset += 1 + sessionLength;
  if (hello.length < offset + 2) return { state: 'invalid' };
  const cipherLength = hello.readUInt16BE(offset);
  offset += 2 + cipherLength;
  if (hello.length < offset + 1) return { state: 'invalid' };
  const compressionLength = hello[offset];
  offset += 1 + compressionLength;
  if (hello.length < offset + 2) return { state: 'invalid' };
  const extensionsLength = hello.readUInt16BE(offset);
  offset += 2;
  const end = offset + extensionsLength;
  if (end !== hello.length) return { state: 'invalid' };

  while (offset + 4 <= end) {
    const type = hello.readUInt16BE(offset);
    const length = hello.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > end) return { state: 'invalid' };
    if (type === 0) return parseServerName(hello.subarray(offset, offset + length));
    offset += length;
  }
  return { state: 'invalid' };
}

function parseServerName(extension) {
  if (extension.length < 5 || extension.readUInt16BE(0) !== extension.length - 2) {
    return { state: 'invalid' };
  }
  let offset = 2;
  while (offset + 3 <= extension.length) {
    const type = extension[offset];
    const length = extension.readUInt16BE(offset + 1);
    offset += 3;
    if (offset + length > extension.length) return { state: 'invalid' };
    if (type === 0) {
      const hostname = extension.subarray(offset, offset + length).toString('ascii').toLowerCase();
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
        return { state: 'invalid' };
      }
      return { state: 'ok', servername: hostname };
    }
    offset += length;
  }
  return { state: 'invalid' };
}
