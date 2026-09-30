// Layer 11A — deterministic barcode normalization (pure).
import { describe, expect, it } from 'vitest';
import { checkDigitValid, expandUpcE, isProductIdentity, normalizeBarcode } from '../../src/domain/products/barcode';

describe('barcode normalization (B/C/D)', () => {
  it.each([
    ['4006381333931', undefined, '04006381333931', 'ean_13'],
    ['036000291452', undefined, '00036000291452', 'upc_a'],
    ['0036000291452', undefined, '00036000291452', 'ean_13'], // UPC-A as EAN-13: same GTIN
    ['96385074', 'ean_8', '00000096385074', 'ean_8'],
    ['01234565', 'upc_e', '00012345000065', 'upc_e'], // UPC-E -> UPC-A 012345000065
    ['10036000291459', undefined, '10036000291459', 'gtin_14'],
    [' 4006-3813 33931 ', undefined, '04006381333931', 'ean_13'], // formatting stripped
  ] as const)('%s -> %s', (code, type, gtin, barcodeType) => {
    expect(normalizeBarcode(code, type)).toMatchObject({ ok: true, gtin, barcode_type: barcodeType });
  });

  it('UPC-A and its EAN-13 form are one canonical identity; UPC-E expands to that UPC-A', () => {
    const upcA = normalizeBarcode('012345000065');
    const upcE = normalizeBarcode('01234565', 'upc_e');
    expect(upcA.ok && upcE.ok && upcA.gtin === upcE.gtin).toBe(true);
    expect(expandUpcE('01234565')).toBe('012345000065');
    expect(expandUpcE('04252614')).toBe('042100005264');
  });

  it.each([
    ['01234505', '012000003455'], // last digit 0-2: manufacturer d1 d2 X 0 0, item 0 0 d3 d4 d5
    ['01234531', '012300000451'], // 3: d1 d2 d3 0 0, item 0 0 0 d4 d5
    ['01234543', '012340000053'], // 4: d1-d4 0, item 0 0 0 0 d5
    ['01234565', '012345000065'], // 5-9: d1-d5, item 0 0 0 0 X
    ['12345694', '123456000094'], // number system 1
  ])('UPC-E %s expands to UPC-A %s (standard rules) and shares its GTIN', (upcE, upcA) => {
    expect(expandUpcE(upcE)).toBe(upcA);
    const e = normalizeBarcode(upcE, 'upc_e');
    const a = normalizeBarcode(upcA);
    expect(e).toMatchObject({ ok: true, gtin: `00${upcA}`, barcode_type: 'upc_e', digits: upcE });
    expect(a.ok && e.ok && a.gtin === e.gtin).toBe(true);
  });

  it.each([
    ['4006381333932', undefined, 'invalid_check_digit'],
    ['036000291453', undefined, 'invalid_check_digit'],
    ['01234566', 'upc_e', 'invalid_check_digit'],
    ['96385075', 'ean_8', 'invalid_check_digit'],
    ['96385074', undefined, 'ambiguous_format'], // EAN-8 or UPC-E: never guessed
    ['4006381333931', 'upc_a', 'type_length_mismatch'],
    ['21234569', 'upc_e', 'invalid_upc_e'],
    ['40063813339', undefined, 'invalid_length'],
    ['4006381333931X', undefined, 'invalid_characters'],
    ['400638133393.1', undefined, 'invalid_characters'],
    ['2012345678903', undefined, 'restricted_circulation'], // in-store / variable measure
    ['212345678909', undefined, 'restricted_circulation'], // UPC number system 2
    ['501234567890', undefined, 'restricted_circulation'], // UPC number system 5 (coupon)
    ['21234569', 'ean_8', 'restricted_circulation'], // restricted EAN-8
    ['00123457', 'ean_8', 'restricted_circulation'],
    ['000012345670', undefined, 'reserved_range'], // would collide with the EAN-8 space
  ] as const)('%s is rejected (%s)', (code, type, reason) => {
    expect(normalizeBarcode(code, type)).toMatchObject({ ok: false, reason });
  });

  it('is deterministic and never uses anything but the digits', () => {
    const a = normalizeBarcode('4006381333931');
    for (let i = 0; i < 5; i += 1) expect(normalizeBarcode('4006381333931')).toEqual(a);
  });

  it('check digit and identity rules', () => {
    expect(checkDigitValid('5901234123457')).toBe(true);
    expect(checkDigitValid('5901234123458')).toBe(false);
    expect(isProductIdentity('95901234123450')).toBe(false); // indicator 9: variable-measure trade item
    expect(isProductIdentity('09780306406126')).toBe(true); // ISBN-13 (Bookland) is a product identity
  });
});
