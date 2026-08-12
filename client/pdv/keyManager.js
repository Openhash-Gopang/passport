/**
 * @file keyManager.js
 * @description Ed25519 키쌍 생성·서명·검증·AES-256-GCM 암호화·삼중 서명
 * @version 1.0.0 (SSOT 사본 — 원본: Openhash-Gopang/gopang src/pdv/keyManager.js)
 *
 * ⚠️ 이 파일은 gopang 저장소 원본의 SSOT 사본이다. gopang의 pdv-history-client.js를
 *    klaw/gdc/security에 배포한 것과 동일한 패턴(2026-07-17 결정).
 *    원본이 갱신되면 이 사본도 함께 갱신해야 한다 — 별도 동기화 자동화는 미구현.
 *
 * ⚠️  개인키(privateKey)는 non-extractable로 생성된다.
 *     기기 밖으로 절대 이탈하지 않는다.
 */

const subtle = globalThis.crypto?.subtle;
if (!subtle) throw new Error('[keyManager] Web Crypto API를 사용할 수 없습니다.');

function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function strToBuf(str) {
  return new TextEncoder().encode(str);
}

export async function generateKeyPair() {
  const keyPair = await subtle.generateKey(
    { name: 'Ed25519' }, false, ['sign', 'verify']
  );
  const pubKeyRaw = await subtle.exportKey('raw', keyPair.publicKey);
  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, publicKeyB64: bufToB64(pubKeyRaw) };
}

export async function importPublicKey(publicKeyB64) {
  return subtle.importKey('raw', b64ToBuf(publicKeyB64), { name: 'Ed25519' }, true, ['verify']);
}

export async function signMessage(message, privateKey) {
  const sig = await subtle.sign({ name: 'Ed25519' }, privateKey, strToBuf(message));
  return bufToB64(sig);
}

export async function verifySignature(message, signatureB64, publicKey) {
  const pubKey = typeof publicKey === 'string' ? await importPublicKey(publicKey) : publicKey;
  return subtle.verify({ name: 'Ed25519' }, pubKey, b64ToBuf(signatureB64), strToBuf(message));
}

export async function sha256(input) {
  const hashBuf = await subtle.digest('SHA-256', strToBuf(input));
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function doubleSha256(input) {
  return sha256(await sha256(input));
}

/**
 * 삼중 서명 검증 (issuer 서명 + 사용자 확인 + OpenHash 앵커 — Phase 2에서 실연동)
 */
export function createTripleSignature(userSignature, agentSignature, openHashRef) {
  return { userSignature, agentSignature, openHashRef, createdAt: new Date().toISOString(), version: '1.0' };
}

export async function verifyTripleSignature(triple, message, userPubKeyB64, agentPubKeyB64) {
  const [user, agent] = await Promise.all([
    verifySignature(message, triple.userSignature, userPubKeyB64),
    verifySignature(message, triple.agentSignature, agentPubKeyB64),
  ]);
  const openHash = typeof triple.openHashRef === 'string' && triple.openHashRef.length > 0;
  return { user, agent, openHash, all: user && agent && openHash };
}
