import { chromium } from 'playwright'

export async function renderTimetablePdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true })

  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 990 },
      deviceScaleFactor: 2,
    })

    await page.setContent(html, { waitUntil: 'networkidle' })

    const pdf = await page.pdf({
      format: 'A4',
      landscape: true,
      margin: {
        top: '8mm',
        right: '8mm',
        bottom: '8mm',
        left: '8mm',
      },
      preferCSSPageSize: true,
      printBackground: true,
    })

    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
