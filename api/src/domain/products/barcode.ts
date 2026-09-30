// Layer 11A — deterministic barcode normalization (G4). Pure; no AI, no
// guessing. Every accepted code becomes its canonical 14-digit GTIN:
//
//   EAN-13  13 digits           -> '0' + code
//   UPC-A   12 digits           -> '00' + code      (= EAN-13 '0' + UPC-A)
//   UPC-E   8 digits, declared  -> expanded to UPC-A, then '00' + UPC-A
//   EAN-8   8 digits, declared  -> '000000' + code
//   GTIN-14 14 digits           -> code
//
// Formatting: surrounding whitespace, inner spaces and hyphens are removed;
// any other character is invalid. An 8-digit code is EAN-8 or UPC-E and the
// two cannot be told apart from the digits, so its type must be declared.
// The GS1 mod-10 check digit is always validated (UPC-E: the expanded
// UPC-A's). Restricted-circulation, variable-measure and coupon ranges are
// not product identities. Mirrors gtin_is_product_identity() in migration
// 20261010120000 (the database re-checks every stored GTIN).

export const BARCODE_TYPES = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'gtin_14'] as const;
export type BarcodeType = (typeof BARCODE_TYPES)[number];
export const BARCODE_RULES_VERSION = 'barcode-normalization-11a.1';

export type BarcodeRejection =
  | 'invalid_characters'
  | 'invalid_length'
  | 'ambiguous_format'
  | 'type_length_mismatch'
  | 'invalid_upc_e'
  | 'invalid_check_digit'
  | 'reserved_range'
  | 'restricted_circulation';

export type NormalizedBarcode =
  | { ok: true; gtin: string; barcode_type: BarcodeType; digits: string }
  | { ok: false; reason: BarcodeRejection; message: string };

const TYPE_LENGTH: Record<BarcodeType, number> = { ean_13: 13, ean_8: 8, upc_a: 12, upc_e: 8, gtin_14: 14 };

export function checkDigitValid(code: string): boolean {
  if (!/^[0-9]{2,}$/.test(code)) return false;
  let total = 0;
  let weight = 3;
  for (let i = code.length - 2; i >= 0; i -= 1) {
    total += Number(code[i]) * weight;
    weight = 4 - weight;
  }
  return (10 - (total % 10)) % 10 === Number(code[code.length - 1]);
}

/** UPC-E (number system 0/1, 6 digits, check) -> UPC-A, or null. */
export function expandUpcE(code: string): string | null {
  if (!/^[01][0-9]{7}$/.test(code)) return null;
  const ns = code[0] as string;
  const [d1, d2, d3, d4, d5, x6] = code.slice(1, 7).split('') as [string, string, string, string, string, string];
  const check = code[7] as string;
  let body: string;
  if (x6 === '0' || x6 === '1' || x6 === '2') body = `${d1}${d2}${x6}0000${d3}${d4}${d5}`;
  else if (x6 === '3') body = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (x6 === '4') body = `${d1}${d2}${d3}${d4}00000${d5}`;
  else body = `${d1}${d2}${d3}${d4}${d5}0000${x6}`;
  return `${ns}${body}${check}`;
}

/** A canonical GTIN-14 that may identify a product (same rule as the DB). */
export function isProductIdentity(gtin: string): boolean {
  if (!/^[0-9]{14}$/.test(gtin) || !checkDigitValid(gtin)) return false;
  if (gtin.startsWith('9')) return false; // variable-measure trade item
  if (gtin.startsWith('000000')) return !['0', '2'].includes(gtin[6] as string); // restricted EAN-8
  const body = gtin.slice(1);
  return !(['02', '04', '05', '99'].includes(body.slice(0, 2)) || body.startsWith('2') || ['980', '981', '982', '983', '984'].includes(body.slice(0, 3)));
}

const reject = (reason: BarcodeRejection, message: string): NormalizedBarcode => ({ ok: false, reason, message });

export function normalizeBarcode(raw: string, declaredType?: BarcodeType): NormalizedBarcode {
  const digits = raw.trim().replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(digits)) return reject('invalid_characters', 'A barcode contains digits only (spaces and hyphens are ignored).');
  let type: BarcodeType;
  if (declaredType) {
    if (TYPE_LENGTH[declaredType] !== digits.length) return reject('type_length_mismatch', `A ${declaredType} code has ${TYPE_LENGTH[declaredType]} digits.`);
    type = declaredType;
  } else if (digits.length === 13) type = 'ean_13';
  else if (digits.length === 12) type = 'upc_a';
  else if (digits.length === 14) type = 'gtin_14';
  else if (digits.length === 8) return reject('ambiguous_format', 'An 8-digit code may be EAN-8 or UPC-E; declare its type.');
  else return reject('invalid_length', 'A barcode has 8, 12, 13 or 14 digits.');

  let gtin: string;
  if (type === 'upc_e') {
    const upcA = expandUpcE(digits);
    if (!upcA) return reject('invalid_upc_e', 'A UPC-E code starts with number system 0 or 1.');
    if (!checkDigitValid(upcA)) return reject('invalid_check_digit', 'The check digit is not valid.');
    gtin = `00${upcA}`;
  } else {
    if (!checkDigitValid(digits)) return reject('invalid_check_digit', 'The check digit is not valid.');
    gtin = digits.padStart(14, '0');
  }
  // GS1 keeps 12/13-digit codes out of the zero-padded GTIN-8 space, so a
  // longer code landing there would collide with an EAN-8 identity.
  if (type !== 'ean_8' && type !== 'gtin_14' && gtin.startsWith('000000')) {
    return reject('reserved_range', 'This code falls in the range reserved for EAN-8 identities.');
  }
  if (!isProductIdentity(gtin)) return reject('restricted_circulation', 'This code is a restricted-circulation, variable-measure or coupon code, not a product identity.');
  return { ok: true, gtin, barcode_type: type, digits };
}
