// Product name on exported files.
//
// The findings PDF and Excel for vessel review are shared outside the office, so they carry NO product name until
// the official launch: their header, banner, document properties and file names say "Emissions Validation" only.
// AT LAUNCH: set FINDINGS_PRODUCT_NAME = PRODUCT_NAME below; the findings PDF and Excel follow.
//
// The diagnostic report (XLSX/JSON) and the app's own screens keep the product name.
// (No imports: the app's screens use the same banner texts.)

export const PRODUCT_NAME = "NeraVeda"

export const FINDINGS_PRODUCT_NAME: string | null = null

export const EXPORT_APP_NAME = "Emissions Validation"

export function reportBanner(product: string | null): string {
  return `${product ? `${product.toUpperCase()} ` : ""}DIAGNOSTIC REPORT — NOT AN OFFICIAL VESSEL REPORTING FILE`
}

/** Start of an export file name, e.g. "NERAVEDA-", or nothing without a product name. */
export function filePrefix(product: string | null): string {
  return product ? `${product.toUpperCase().replace(/[^A-Z0-9]+/g, "-")}-` : ""
}

/** The findings PDF page header: the square mark, the title and the line under it. */
export function exportHeader(document: string, product: string | null = FINDINGS_PRODUCT_NAME) {
  return product
    ? { mark: product.slice(0, 1).toUpperCase(), title: product, subtitle: `${EXPORT_APP_NAME} · ${document}` }
    : { mark: "EV", title: EXPORT_APP_NAME, subtitle: document }
}

/** Findings PDF document properties (Creator, Producer, Keywords). */
export function exportMetadata(product: string | null = FINDINGS_PRODUCT_NAME) {
  return {
    creator: product ? `${product} ${EXPORT_APP_NAME}` : EXPORT_APP_NAME,
    producer: product ?? EXPORT_APP_NAME,
    keywords: product ? [product] : [],
  }
}

/** Banner of the diagnostic report (XLSX/JSON). */
export const REPORT_BANNER = reportBanner(PRODUCT_NAME)

/** Banner of the findings PDF and Excel for vessel review. */
export const FINDINGS_BANNER = reportBanner(FINDINGS_PRODUCT_NAME)
