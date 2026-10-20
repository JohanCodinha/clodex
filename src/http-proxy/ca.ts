import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import forge from 'node-forge';
import { getAppHome } from '../paths.js';

export interface HttpProxyCertificates {
  caCertPath: string;
  caCert: string;
  serverCert: string;
  serverKey: string;
}

const CERT_DIR = 'http-proxy';
const CA_CERT_FILE = 'clodex-ca.pem';
const CA_KEY_FILE = 'clodex-ca-key.pem';
const SERVER_CERT_FILE = 'api.anthropic.com.pem';
const SERVER_KEY_FILE = 'api.anthropic.com-key.pem';
const CERT_VERSION_FILE = 'version';
// 2: the server certificate carries an Authority Key Identifier. Python 3.13+ verifies with
// VERIFY_X509_STRICT, which refuses a leaf without one ("Missing Authority Key Identifier"),
// so any Python client sent through the proxy failed on api.anthropic.com. A version-1 store
// keeps its CA and has only the server certificate reissued: live sessions trust the CA by
// content (NODE_EXTRA_CA_CERTS was read at their start), so a new CA would cut them off.
const CERT_VERSION = '2\n';

function serialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString('hex');
}

function certPaths(): Record<'dir' | 'caCert' | 'caKey' | 'serverCert' | 'serverKey' | 'version', string> {
  const dir = join(getAppHome(), CERT_DIR);
  return {
    dir,
    caCert: join(dir, CA_CERT_FILE),
    caKey: join(dir, CA_KEY_FILE),
    serverCert: join(dir, SERVER_CERT_FILE),
    serverKey: join(dir, SERVER_KEY_FILE),
    version: join(dir, CERT_VERSION_FILE),
  };
}

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function writePublic(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o644 });
  chmodSync(path, 0o644);
}

function generateServerCertificate(
  paths: ReturnType<typeof certPaths>,
  caCert: forge.pki.Certificate,
  caKey: forge.pki.PrivateKey,
): void {
  const caKeyId = (caCert.getExtension('subjectKeyIdentifier') as { subjectKeyIdentifier?: string } | null)
    ?.subjectKeyIdentifier;
  const serverKeys = forge.pki.rsa.generateKeyPair(2048);
  const serverCert = forge.pki.createCertificate();
  serverCert.publicKey = serverKeys.publicKey;
  serverCert.serialNumber = serialNumber();
  serverCert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  serverCert.validity.notAfter = new Date(Date.now() + 825 * 24 * 60 * 60 * 1000);
  serverCert.setSubject([{ name: 'commonName', value: 'api.anthropic.com' }]);
  serverCert.setIssuer(caCert.subject.attributes);
  serverCert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'api.anthropic.com' }] },
    { name: 'subjectKeyIdentifier' },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: caKeyId
        ? forge.util.hexToBytes(caKeyId)
        : caCert.generateSubjectKeyIdentifier().getBytes(),
    },
  ]);
  serverCert.sign(caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

  writePrivate(paths.serverKey, forge.pki.privateKeyToPem(serverKeys.privateKey));
  writePublic(paths.serverCert, forge.pki.certificateToPem(serverCert));
}

function generateCertificates(paths: ReturnType<typeof certPaths>): void {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);

  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = serialNumber();
  caCert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  caCert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const caAttrs = [{ name: 'commonName', value: 'clodex local HTTP proxy CA' }];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  writePrivate(paths.caKey, forge.pki.privateKeyToPem(caKeys.privateKey));
  writePublic(paths.caCert, forge.pki.certificateToPem(caCert));
  generateServerCertificate(paths, caCert, caKeys.privateKey);
  writePublic(paths.version, CERT_VERSION);
}

const RENEWAL_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

/** Valid now, and still valid once the renewal buffer has passed. */
function staysValid(cert: forge.pki.Certificate, now: number): boolean {
  return cert.validity.notBefore.getTime() <= now
    && cert.validity.notAfter.getTime() > now + RENEWAL_BUFFER_MS;
}

function keyMatchesCertificate(cert: forge.pki.Certificate, key: forge.pki.PrivateKey): boolean {
  return (cert.publicKey as forge.pki.rsa.PublicKey).n.compareTo((key as forge.pki.rsa.PrivateKey).n) === 0;
}

/** The stored CA and its key, when both load, pair, and stay valid past the renewal buffer. */
function loadCurrentCa(
  paths: ReturnType<typeof certPaths>,
): { caCert: forge.pki.Certificate; caKey: forge.pki.PrivateKey } | null {
  try {
    const caCert = forge.pki.certificateFromPem(readFileSync(paths.caCert, 'utf8'));
    const caKey = forge.pki.privateKeyFromPem(readFileSync(paths.caKey, 'utf8'));
    if (!staysValid(caCert, Date.now())) return null;
    if (!caCert.verify(caCert)) return null;
    if (!keyMatchesCertificate(caCert, caKey)) return null;
    return { caCert, caKey };
  } catch {
    return null;
  }
}

function storedCertificatesAreCurrent(paths: ReturnType<typeof certPaths>): boolean {
  try {
    const ca = forge.pki.certificateFromPem(readFileSync(paths.caCert, 'utf8'));
    const server = forge.pki.certificateFromPem(readFileSync(paths.serverCert, 'utf8'));
    const serverKey = forge.pki.privateKeyFromPem(readFileSync(paths.serverKey, 'utf8'));
    const now = Date.now();
    // Two starts that reissue at once can leave one's key beside the other's certificate, and
    // the CA signed both, so only the pairing check sees it. Failing here lets the CA-preserving
    // path repair the store instead of every later start dying on "key values mismatch".
    return staysValid(ca, now)
      && staysValid(server, now)
      && ca.verify(ca)
      && ca.verify(server)
      && keyMatchesCertificate(server, serverKey);
  } catch {
    return false;
  }
}

/** Create the local CA once, then reuse it so active sessions keep trusting the proxy. */
export function ensureHttpProxyCertificates(): HttpProxyCertificates {
  const paths = certPaths();
  const required = [paths.caCert, paths.caKey, paths.serverCert, paths.serverKey, paths.version];
  const current = required.every(existsSync)
    && readFileSync(paths.version, 'utf8') === CERT_VERSION
    && storedCertificatesAreCurrent(paths);
  if (!current) {
    // Keep a sound CA (see CERT_VERSION); reissue only what it signs.
    const ca = loadCurrentCa(paths);
    if (ca) {
      generateServerCertificate(paths, ca.caCert, ca.caKey);
      writePublic(paths.version, CERT_VERSION);
    } else {
      generateCertificates(paths);
    }
  }

  return {
    caCertPath: paths.caCert,
    caCert: readFileSync(paths.caCert, 'utf8'),
    serverCert: readFileSync(paths.serverCert, 'utf8'),
    serverKey: readFileSync(paths.serverKey, 'utf8'),
  };
}

/** Preserve an existing corporate/custom Node CA bundle alongside Relay's CA. */
export function ensureHttpProxyCaBundle(
  relayCaCertPath: string,
  additionalCaCertPath: string | undefined,
  // A dropped CA is silent on every layer below this one: the merge used to
  // swallow the failure, and Node prints only an opaque OpenSSL code for a
  // NODE_EXTRA_CA_CERTS it cannot load. Someone has to say it out loud.
  onWarning?: (message: string) => void,
): string {
  if (!additionalCaCertPath?.trim()) return relayCaCertPath;
  const warn = (detail: string): string => {
    // Say what the child actually gets. NODE_EXTRA_CA_CERTS is ADDITIVE to
    // node's built-in roots, so a suffix claiming the child "trusts only" the
    // clodex CA would be false and would send people hunting a second problem.
    onWarning?.(
      `${detail} The CA bundle handed to the child is ${relayCaCertPath}; `
      + "node's built-in roots are unaffected.",
    );
    return relayCaCertPath;
  };
  let additionalCa: string;
  try {
    if (resolve(additionalCaCertPath) === resolve(relayCaCertPath)) return relayCaCertPath;
    additionalCa = readFileSync(additionalCaCertPath, 'utf8').trim();
  } catch (err) {
    // Node warns for ENOENT/EACCES/ELOOP but is SILENT for EISDIR, and only
    // once some process actually initializes its TLS roots -- so describe its
    // warning conditionally, and never as something that always appears.
    return warn(
      `NODE_EXTRA_CA_CERTS=${additionalCaCertPath} cannot be read `
      + `(${err instanceof Error ? err.message : String(err)}), so it is not part of the proxy `
      + 'CA bundle. Where node reports this itself it says only "Ignoring extra certs ... load '
      + 'failed", without naming the variable. Clear or correct it.',
    );
  }
  // Deliberately NOT claimed as "carries no certificate": this tests emptiness,
  // not PEM validity. A non-empty file of junk is merged verbatim and OpenSSL
  // discards it a layer down, silently -- as it does without clodex. Node is
  // silent for an empty file too, so its warning is not mentioned here.
  if (!additionalCa) {
    return warn(`NODE_EXTRA_CA_CERTS=${additionalCaCertPath} is empty, so it adds nothing.`);
  }
  try {
    const relayCa = readFileSync(relayCaCertPath, 'utf8').trimEnd();
    const combinedPath = join(dirname(relayCaCertPath), 'combined-ca.pem');
    writePublic(combinedPath, `${relayCa}\n${additionalCa}\n`);
    return combinedPath;
  } catch (err) {
    // clodex's own fault -- an unwritable ~/.clodex/http-proxy, a vanished relay
    // CA, ENOSPC. Do not tell the user to correct their setting. "build" rather
    // than "write" because this catch also covers reading the relay CA, and
    // "readable, non-empty" rather than "valid" because that is all that has
    // actually been established about the configured file.
    return warn(
      `clodex could not build the combined CA bundle in ${dirname(relayCaCertPath)} `
      + `(${err instanceof Error ? err.message : String(err)}), so the readable, non-empty `
      + `NODE_EXTRA_CA_CERTS=${additionalCaCertPath} was left out of it. Fix the reported `
      + 'error and restart clodex.',
    );
  }
}
