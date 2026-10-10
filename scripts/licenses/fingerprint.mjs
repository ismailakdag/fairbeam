import { createHash } from 'node:crypto';

// These inputs are UTF-8 source/configuration files, not downloaded archives. Git
// stores LF but checks PowerShell files out as CRLF on Windows. Canonicalize only
// CRLF pairs; retain all other text so dependency and notice changes invalidate it.
const ownVersion = {
  'package.json': t => t.replace(/^(  "version": ")[^"]*(")/m, '$1$2'),
  'package-lock.json': t => t.replace(/^(  "version": ")[^"]*(")/m, '$1$2').replace(/^(      "name": "fairbeam",\n      "version": ")[^"]*(")/m, '$1$2'),
  'src-tauri/Cargo.toml': t => t.replace(/^(\[package\]\nname = "fairbeam"\nversion = ")[^"]*(")/m, '$1$2'),
  'src-tauri/Cargo.lock': t => t.replace(/^(name = "fairbeam"\nversion = ")[^"]*(")/m, '$1$2')
};

export function licenseInputHash(path, text) {
  const canonical = text.replaceAll('\r\n', '\n');
  return createHash('sha256').update(ownVersion[path] ? ownVersion[path](canonical) : canonical).digest('hex');
}
