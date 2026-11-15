/**
 * India: yes/no comparisons between a supplier's own values, worked out on our server. The AI pre-review gets only
 * the answers (privacy mode) — never the GSTIN, PAN, PIN code or address themselves.
 */
import type { Profile } from '../types.js';
import { GST_STATES } from './gstStates.js';

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const ALIASES: Record<string, string> = { orissa: 'odisha', pondicherry: 'puducherry', uttaranchal: 'uttarakhand', newdelhi: 'delhi', nctofdelhi: 'delhi', jammuandkashmir: 'jammuandkashmir', jandk: 'jammuandkashmir', tn: 'tamilnadu', up: 'uttarpradesh', mp: 'madhyapradesh', ap: 'andhrapradesh', wb: 'westbengal' };
const KNOWN = new Set(Object.values(GST_STATES).map(norm));
/** A state name as typed → its normalised form, or undefined if it isn't a recognisable state. */
export function stateKey(s: unknown) {
  const k = norm(String(s ?? ''));
  const v = ALIASES[k] ?? k;
  if (KNOWN.has(v)) return v;
  if (v === 'damananddiu' || v === 'dadraandnagarhaveli') return norm(GST_STATES['26']);
  return undefined;
}

/** States served by each two-digit PIN code prefix (India Post postal circles; border prefixes list several). */
const PIN: [string, string[]][] = [
  ['11', ['Delhi']], ['12', ['Haryana']], ['13', ['Haryana', 'Punjab']], ['14', ['Punjab']], ['15', ['Punjab']], ['16', ['Punjab', 'Chandigarh', 'Haryana']],
  ['17', ['Himachal Pradesh']], ['18', ['Jammu and Kashmir']], ['19', ['Jammu and Kashmir', 'Ladakh']],
  ['20', ['Uttar Pradesh']], ['21', ['Uttar Pradesh']], ['22', ['Uttar Pradesh']], ['23', ['Uttar Pradesh']], ['24', ['Uttar Pradesh', 'Uttarakhand']],
  ['25', ['Uttar Pradesh']], ['26', ['Uttar Pradesh', 'Uttarakhand']], ['27', ['Uttar Pradesh']], ['28', ['Uttar Pradesh']],
  ['30', ['Rajasthan']], ['31', ['Rajasthan']], ['32', ['Rajasthan']], ['33', ['Rajasthan']], ['34', ['Rajasthan']],
  ['36', ['Gujarat']], ['37', ['Gujarat']], ['38', ['Gujarat']], ['39', ['Gujarat', 'Dadra and Nagar Haveli and Daman and Diu']],
  ['40', ['Maharashtra', 'Goa']], ['41', ['Maharashtra']], ['42', ['Maharashtra']], ['43', ['Maharashtra']], ['44', ['Maharashtra']],
  ['45', ['Madhya Pradesh']], ['46', ['Madhya Pradesh']], ['47', ['Madhya Pradesh']], ['48', ['Madhya Pradesh']], ['49', ['Chhattisgarh']],
  ['50', ['Telangana', 'Andhra Pradesh']], ['51', ['Andhra Pradesh', 'Telangana']], ['52', ['Andhra Pradesh']], ['53', ['Andhra Pradesh']],
  ['56', ['Karnataka']], ['57', ['Karnataka']], ['58', ['Karnataka']], ['59', ['Karnataka']],
  ['60', ['Tamil Nadu', 'Puducherry']], ['61', ['Tamil Nadu']], ['62', ['Tamil Nadu']], ['63', ['Tamil Nadu']], ['64', ['Tamil Nadu']],
  ['67', ['Kerala', 'Puducherry']], ['68', ['Kerala', 'Lakshadweep']], ['69', ['Kerala']],
  ['70', ['West Bengal']], ['71', ['West Bengal']], ['72', ['West Bengal']], ['73', ['West Bengal', 'Sikkim']], ['74', ['West Bengal', 'Andaman and Nicobar Islands']],
  ['75', ['Odisha']], ['76', ['Odisha']], ['77', ['Odisha']], ['78', ['Assam']],
  ['79', ['Arunachal Pradesh', 'Meghalaya', 'Manipur', 'Mizoram', 'Nagaland', 'Tripura', 'Assam']],
  ['80', ['Bihar']], ['81', ['Bihar', 'Jharkhand']], ['82', ['Bihar', 'Jharkhand']], ['83', ['Jharkhand', 'Bihar']], ['84', ['Bihar']], ['85', ['Bihar']],
];
const PIN_STATES = new Map(PIN.map(([k, v]) => [k, new Set(v.map(norm))]));

/** PAN 4th character → the types of entity it fits. */
const PAN_TYPE: Record<string, string[]> = {
  C: ['Company (Pvt / Public Ltd)'], F: ['Limited Liability Partnership', 'Partnership Firm'], P: ['Individual / Proprietorship'],
  H: ['Hindu Undivided Family (HUF)'], A: ['Association of Persons'], B: ['Association of Persons'], T: ['Trust'], G: ['Government Organisation'], L: ['Government Organisation'], J: ['Trust', 'Association of Persons'],
};

export function indiaConsistencyFacts(p: Profile): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const india = String(p.basic?.supplierCountry ?? 'India') === 'India';
  if (!india) return out;
  const gstin = String(p.tax?.gstin ?? '').toUpperCase().trim();
  const pan = String(p.tax?.pan ?? '').toUpperCase().trim();
  const state = stateKey(p.basic?.region);
  const pin = String(p.basic?.postalCode ?? '').replace(/\s/g, '');
  if (/^\d{2}[A-Z0-9]{13}$/.test(gstin) && state && GST_STATES[gstin.slice(0, 2)]) out['GSTIN state matches the address state'] = norm(GST_STATES[gstin.slice(0, 2)]) === state;
  if (/^[1-9]\d{5}$/.test(pin) && state && PIN_STATES.has(pin.slice(0, 2))) out['PIN code matches the address state'] = PIN_STATES.get(pin.slice(0, 2))!.has(state);
  if (gstin.length === 15 && pan.length === 10) out['PAN inside the GSTIN matches the PAN given'] = gstin.slice(2, 12) === pan;
  const entity = String(p.basic?.entityType ?? '');
  if (/^[A-Z]{5}\d{4}[A-Z]$/.test(pan) && entity && PAN_TYPE[pan[3]]) out['PAN type matches the type of entity'] = PAN_TYPE[pan[3]].includes(entity);
  return out;
}
