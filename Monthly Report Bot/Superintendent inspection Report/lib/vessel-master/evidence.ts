// Ship's documents a value can be verified against on board (lib/vessel-master/verify.ts). Pure: used by the browser too.

export const DOCUMENT_TYPES = [
  "Certificate of Registry", "Classification certificate", "International Tonnage Certificate", "International Load Line Certificate",
  "EIAPP certificate / NOx Technical File", "Shop test report", "Sea trial report", "Shipbuilding contract / specification",
  "Ship's particulars / capacity plan", "Other ship's document",
] as const
