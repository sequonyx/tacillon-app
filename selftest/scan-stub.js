/* Self-test stub for js/scan.js — swapped in by the import map in selftest.html.
   gates.js imports scanQR directly, so a mismatched tag cannot be simulated any
   other way. The next value the "camera" returns is set by the harness.

   Shape matches the real module: qrSupported() -> boolean,
   scanQR() -> Promise<string|null> (null = cancelled or camera unavailable). */

let nextValue = null;

/* Harness control. Call before clicking a SCAN TAG button. */
export function __setNextScan(value) { nextValue = value; }

export function qrSupported() { return true; }

export function scanQR() { return Promise.resolve(nextValue); }
