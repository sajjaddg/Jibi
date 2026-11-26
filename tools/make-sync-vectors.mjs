#!/usr/bin/env node
/**
 * Writes the golden vectors of the sync seal (docs/SYNC_PROTOCOL.md § 10) into
 * sync/test/vectors/. Run it after adding a case; never edit a vector by hand.
 *
 *   node tools/make-sync-vectors.mjs
 *
 * Everything is derived from the case's name, so a second run changes nothing. That is also why
 * these keys and nonces are for tests only: a real record's nonce is random and used once.
 *
 * The seal is written here from the contract, with Node's AES-GCM, rather than imported from
 * either client: the point is a third implementation both of them have to agree with.
 */

import { createCipheriv, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'sync', 'test', 'vectors');

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest();
const sha256Hex = (text) => sha256(text).toString('hex');
const hexOf = (text) => Buffer.from(text, 'utf8').toString('hex');

const HID = '0123456789abcdef0123456789abcdef';
const SCOPE = `family:${HID}`;
const MEMBER = '018f0000000070008000000000000001';
const OTHER = '018f0000000070008000000000000002';
const LOCAL_REF = 's:' + sha256Hex('a bank message') + ':0';
const FAMILY_REF = `txn:${MEMBER}:${hexOf(LOCAL_REF)}`;
const AT = 1795000000000;

/** `payload` is the object a client would encode; the string it becomes is what is sealed. */
const CASES = [
  {
    name: 'member', kind: 'member', id: `member:${MEMBER}`,
    payload: { kind: 'member', memberId: MEMBER, name: 'مریم', sharesSms: false, avatar: '' },
  },
  {
    name: 'transaction', kind: 'transaction', id: FAMILY_REF,
    payload: {
      kind: 'transaction', ownerMemberId: MEMBER, sourceKind: 'sms', at: AT, amountRial: 12500000,
      direction: 'out', bank: 'SAMAN', categoryId: 'cat_food', categoryName: 'رستوران و کافه',
      categoryKind: 'expense', transfer: false, categoryGlyph: '', categoryEditorId: MEMBER,
      categoryUpdatedAt: 0, categoryEditedAt: 0, merchant: 'کافه | «تست»',
    },
  },
  {
    name: 'category', kind: 'category', id: `category:${sha256Hex(FAMILY_REF)}`,
    payload: {
      kind: 'category', target: FAMILY_REF, categoryId: 'cat_food', categoryName: 'رستوران و کافه',
      categoryKind: 'expense', categoryGlyph: '', editedByMemberId: OTHER, categoryEditedAt: 0,
    },
  },
  {
    name: 'asset', kind: 'asset', id: `asset:${MEMBER}`,
    payload: { kind: 'asset', memberId: MEMBER, totalToman: 178563180.5, items: [{ name: 'طلای ۱۸', toman: 178563180.5 }] },
  },
  {
    name: 'note', kind: 'note', id: `note:${sha256Hex(FAMILY_REF)}`,
    payload: { kind: 'note', target: FAMILY_REF, note: 'کادوی تولد مامان', editedByMemberId: OTHER },
  },
  {
    name: 'goal', kind: 'goal', id: 'goal:018f0000-0000-7000-8000-0000000000aa',
    payload: {
      kind: 'goal', goalId: '018f0000-0000-7000-8000-0000000000aa', nameFa: 'سفر', targetRial: 500000000,
      goalKind: 'save', categoryId: '', period: 'jmonth', startsOn: AT, endsOn: null, createdAt: AT,
      ownerMemberId: MEMBER, editedByMemberId: MEMBER,
    },
  },
  {
    name: 'exclusion', kind: 'exclusion', id: 'exclusion:report',
    payload: { kind: 'exclusion', categoryIds: ['cat_loan'], editedByMemberId: MEMBER },
  },
  {
    name: 'tombstone', kind: 'goal', id: 'goal:018f0000-0000-7000-8000-0000000000bb',
    payload: { v: 1, id: 'goal:018f0000-0000-7000-8000-0000000000bb', deleted: true },
  },
  {
    // The unbound seal every record before `recordAad` wore, which readers still fall back to.
    name: 'legacy', kind: 'legacy', id: LOCAL_REF, unbound: true,
    payload: { at: AT, amountRial: 1000, direction: 'in' },
  },
];

// The vault kinds. Their payloads are not designed yet (docs/SYNC_PROTOCOL.md § 3), so each is a
// placeholder: what these pin is the AAD and the id's namespace.
const VAULT = {
  sms: sha256Hex('a bank message'), manual_txn: 'm:018f0000-0000-7000-8000-0000000000cc', anchor: '1',
  rule: '1', decision: `${LOCAL_REF}:category`, link: '1', holding: 'gold18', bank: 'SAMAN',
  loan_person: '018f0000-0000-7000-8000-0000000000dd', override: 'usd', day: '2026-11-26',
  pref: 'quipTone', entitlement: '00112233445566778899aabbccddeeff',
};
for (const [kind, key] of Object.entries(VAULT)) {
  CASES.push({ name: kind, kind, id: `${kind}:${key}`, scope: `vault:${HID}`, payload: { kind } });
}

function vector({ name, kind, id, payload, unbound = false, scope = SCOPE }) {
  const key = sha256(`muchtoman sync vector key|${scope}`);
  const nonce = sha256(`muchtoman sync vector nonce|${name}`).subarray(0, 12);
  const aad = unbound ? null : `mt1|${scope}|${kind}|${id}`;
  const plaintext = JSON.stringify(payload);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad !== null) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    name, kind, scope, id, aad,
    key: key.toString('base64url'),
    nonce: nonce.toString('base64'),
    plaintext,
    body: body.toString('base64'),
  };
}

mkdirSync(out, { recursive: true });
for (const file of readdirSync(out)) if (file.endsWith('.json')) rmSync(join(out, file));
for (const c of CASES) writeFileSync(join(out, `${c.name}.json`), JSON.stringify(vector(c), null, 2) + '\n');
console.log(`wrote ${CASES.length} vectors to ${out}`);
