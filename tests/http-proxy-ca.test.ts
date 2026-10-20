import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createSecureContext } from 'node:tls';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';
import { ensureHttpProxyCertificates } from '../src/http-proxy/ca.js';

// Python 3.13+ verifies with VERIFY_X509_STRICT; OpenSSL 3's -x509_strict is the same check.
// macOS ships LibreSSL as /usr/bin/openssl, so accept a binary only when it reports OpenSSL 3+.
const OPENSSL = ['/opt/homebrew/opt/openssl@3/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl', '/usr/bin/openssl']
  .filter(existsSync)
  .find((bin) => /^OpenSSL [3-9]\./.test(spawnSync(bin, ['version'], { encoding: 'utf8' }).stdout ?? ''));

let home: string;
const previousHome = process.env['CLODEX_HOME'];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clodex-ca-'));
  process.env['CLODEX_HOME'] = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['CLODEX_HOME'];
  else process.env['CLODEX_HOME'] = previousHome;
});

const dir = () => join(home, 'http-proxy');

function akiMatchesCa(caPem: string, serverPem: string): boolean {
  const ca = forge.pki.certificateFromPem(caPem);
  const server = forge.pki.certificateFromPem(serverPem);
  const ski = (ca.getExtension('subjectKeyIdentifier') as { subjectKeyIdentifier: string }).subjectKeyIdentifier;
  const aki = server.getExtension('authorityKeyIdentifier') as { value: string } | null;
  if (!aki) return false;
  // AuthorityKeyIdentifier ::= SEQUENCE { keyIdentifier [0] ..., ... }
  const fields = forge.asn1.fromDer(aki.value).value as forge.asn1.Asn1[];
  const keyId = fields.find((f) => f.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && f.type === 0);
  return typeof keyId?.value === 'string' && forge.util.bytesToHex(keyId.value) === ski;
}

const DAY = 24 * 60 * 60 * 1000;
const read = (file: string) => readFileSync(join(dir(), file), 'utf8');

/** Rewrite the stored CA certificate around the stored CA key, with the given validity. */
function rewriteCa(notBefore: Date, notAfter: Date, signer?: forge.pki.rsa.PrivateKey): void {
  const key = forge.pki.privateKeyFromPem(read('clodex-ca-key.pem')) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  const attrs = [{ name: 'commonName', value: 'clodex local HTTP proxy CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(signer ?? key, forge.md.sha256.create());
  writeFileSync(join(dir(), 'clodex-ca.pem'), forge.pki.certificateToPem(cert));
}

/** Replace the stored server certificate with one the stored CA signed, expiring at notAfter. */
function rewriteServerCert(notAfter: Date): void {
  const caCert = forge.pki.certificateFromPem(read('clodex-ca.pem'));
  const caKey = forge.pki.privateKeyFromPem(read('clodex-ca-key.pem')) as forge.pki.rsa.PrivateKey;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: 'commonName', value: 'api.anthropic.com' }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.sign(caKey, forge.md.sha256.create());
  writeFileSync(join(dir(), 'api.anthropic.com-key.pem'), forge.pki.privateKeyToPem(keys.privateKey));
  writeFileSync(join(dir(), 'api.anthropic.com.pem'), forge.pki.certificateToPem(cert));
}

function strictVerify(): string {
  const r = spawnSync(OPENSSL!, ['verify', '-x509_strict', '-CAfile', join(dir(), 'clodex-ca.pem'),
    join(dir(), 'api.anthropic.com.pem')], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.trim();
}

describe('http proxy certificates', () => {
  it('issues a server certificate with an Authority Key Identifier', () => {
    const certs = ensureHttpProxyCertificates();
    expect(akiMatchesCa(certs.caCert, certs.serverCert)).toBe(true);
    expect(readFileSync(join(dir(), 'version'), 'utf8')).toBe('2\n');
  });

  it.skipIf(!OPENSSL)('passes strict X.509 verification', () => {
    ensureHttpProxyCertificates();
    expect(strictVerify()).toMatch(/: OK$/);
  });

  it('keeps a version-1 CA and reissues only the server certificate', () => {
    const first = ensureHttpProxyCertificates();
    writeFileSync(join(dir(), 'version'), '1\n');
    const caKeyBefore = readFileSync(join(dir(), 'clodex-ca-key.pem'), 'utf8');
    const second = ensureHttpProxyCertificates();
    expect(second.caCert).toBe(first.caCert);
    expect(readFileSync(join(dir(), 'clodex-ca-key.pem'), 'utf8')).toBe(caKeyBefore);
    expect(second.serverCert).not.toBe(first.serverCert);
    expect(akiMatchesCa(second.caCert, second.serverCert)).toBe(true);
    expect(readFileSync(join(dir(), 'version'), 'utf8')).toBe('2\n');
  });

  it('regenerates everything when the stored CA key does not match the CA', () => {
    const first = ensureHttpProxyCertificates();
    const other = forge.pki.rsa.generateKeyPair(1024);
    writeFileSync(join(dir(), 'clodex-ca-key.pem'), forge.pki.privateKeyToPem(other.privateKey));
    writeFileSync(join(dir(), 'version'), '1\n');
    const second = ensureHttpProxyCertificates();
    expect(second.caCert).not.toBe(first.caCert);
    expect(akiMatchesCa(second.caCert, second.serverCert)).toBe(true);
  });

  it('leaves a current version-2 store untouched', () => {
    const first = ensureHttpProxyCertificates();
    const second = ensureHttpProxyCertificates();
    expect(second.serverCert).toBe(first.serverCert);
    expect(second.caCert).toBe(first.caCert);
  });

  it('renews an expiring server certificate without replacing the CA', () => {
    const first = ensureHttpProxyCertificates();
    rewriteServerCert(new Date(Date.now() + 3 * DAY));
    const second = ensureHttpProxyCertificates();
    expect(second.caCert).toBe(first.caCert);
    const renewed = forge.pki.certificateFromPem(second.serverCert);
    expect(renewed.validity.notAfter.getTime()).toBeGreaterThan(Date.now() + 365 * DAY);
    expect(akiMatchesCa(second.caCert, second.serverCert)).toBe(true);
  });

  it('repairs a server key that does not match its certificate, keeping the CA', () => {
    const first = ensureHttpProxyCertificates();
    // What two simultaneous starts can leave behind: one's key beside the other's certificate.
    const stray = forge.pki.privateKeyToPem(forge.pki.rsa.generateKeyPair(2048).privateKey);
    writeFileSync(join(dir(), 'api.anthropic.com-key.pem'), stray);
    expect(() => createSecureContext({ key: stray, cert: first.serverCert })).toThrow(/key values mismatch/);
    const second = ensureHttpProxyCertificates();
    expect(second.caCert).toBe(first.caCert);
    expect(() => createSecureContext({ key: second.serverKey, cert: second.serverCert })).not.toThrow();
  });

  it.each([
    ['is not valid yet', () => rewriteCa(new Date(Date.now() + DAY), new Date(Date.now() + 3650 * DAY))],
    ['has expired', () => rewriteCa(new Date(Date.now() - 3650 * DAY), new Date(Date.now() - DAY))],
    ['expires within the renewal buffer', () => rewriteCa(new Date(Date.now() - DAY), new Date(Date.now() + 3 * DAY))],
    ['is not signed by its own key', () => rewriteCa(
      new Date(Date.now() - DAY),
      new Date(Date.now() + 3650 * DAY),
      forge.pki.rsa.generateKeyPair(2048).privateKey,
    )],
  ])('regenerates everything when a version-1 CA %s', (_, breakCa) => {
    ensureHttpProxyCertificates();
    breakCa();
    writeFileSync(join(dir(), 'version'), '1\n');
    const broken = read('clodex-ca.pem');
    const caKeyBefore = read('clodex-ca-key.pem');
    const second = ensureHttpProxyCertificates();
    expect(second.caCert).not.toBe(broken);
    expect(read('clodex-ca-key.pem')).not.toBe(caKeyBefore);
    expect(akiMatchesCa(second.caCert, second.serverCert)).toBe(true);
  });
});
