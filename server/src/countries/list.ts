/** Countries VendorGate knows by name (as stored in the supplier-country fields), with ISO code and currency. */
export interface CountryInfo { name: string; iso: string; currency: string }

export const COUNTRY_LIST: CountryInfo[] = [
  { name: 'India', iso: 'IN', currency: 'INR' },
  { name: 'United Arab Emirates', iso: 'AE', currency: 'AED' },
  { name: 'Saudi Arabia', iso: 'SA', currency: 'SAR' },
  { name: 'Bahrain', iso: 'BH', currency: 'BHD' },
  { name: 'Qatar', iso: 'QA', currency: 'QAR' },
  { name: 'Kuwait', iso: 'KW', currency: 'KWD' },
  { name: 'Oman', iso: 'OM', currency: 'OMR' },
  { name: 'United States', iso: 'US', currency: 'USD' },
  { name: 'United Kingdom', iso: 'GB', currency: 'GBP' },
  { name: 'Germany', iso: 'DE', currency: 'EUR' },
  { name: 'Singapore', iso: 'SG', currency: 'SGD' },
  { name: 'China', iso: 'CN', currency: 'CNY' },
  { name: 'Japan', iso: 'JP', currency: 'JPY' },
];

const byName = new Map(COUNTRY_LIST.map((c) => [c.name.toLowerCase(), c]));
const byIso = new Map(COUNTRY_LIST.map((c) => [c.iso, c]));

export const countryByName = (name?: string | null) => (name ? byName.get(name.trim().toLowerCase()) : undefined);
export const countryByIso = (iso?: string | null) => (iso ? byIso.get(iso.toUpperCase()) : undefined);
/** ISO code for a country name; unknown names pass through unchanged (as the ERP export always did). */
export const isoFor = (name: string) => countryByName(name)?.iso ?? name;
